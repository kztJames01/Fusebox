// Opt-in Streamable HTTP transport for the MCP server.
//
// stdio stays the default. This module adds a single HTTP endpoint that speaks
// JSON-RPC over POST and returns JSON responses (the spec also permits SSE; we
// deliberately keep responses finite and JSON-only). There are no outbound
// calls: the process only listens on an operator-selected interface.
//
// Security posture:
// - binds 127.0.0.1 by default;
// - a bearer token is mandatory before binding a non-loopback interface;
// - Origin is validated to block DNS-rebinding from browsers;
// - request bodies are size-capped;
// - session ids are unguessable UUIDs and can be terminated with DELETE.
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { CliError, ExitCode } from "../engine/errors.js";
import { openIndexStoreSafely } from "../engine/indexStore.js";
import {
  handleMcpMessage,
  isJsonRpcRequest,
  MEMO_LOG_VERSION,
  type JsonRpcResponse,
} from "./server.js";
import type { ToolContext } from "./tools.js";

export const DEFAULT_MCP_HTTP_HOST = "127.0.0.1";
export const DEFAULT_MCP_HTTP_PORT = 7331;
export const MCP_HTTP_PATH = "/mcp";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_SESSIONS = 1000;

export interface McpHttpOptions extends ToolContext {
  host?: string | undefined;
  port?: number | undefined;
  /** Required when `host` is not a loopback address. */
  token?: string | undefined;
  /** Extra origins allowed in addition to loopback origins. */
  allowedOrigins?: readonly string[] | undefined;
  serverVersion?: string | undefined;
  maxBodyBytes?: number | undefined;
}

export interface McpHttpHandle {
  server: Server;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}

function originIsAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  // Non-browser clients normally omit Origin. When it is present, it must be a
  // loopback origin or an explicit operator allowlist entry.
  if (origin === undefined || origin.length === 0) {
    return true;
  }
  if (allowed.includes(origin)) {
    return true;
  }
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      isLoopbackHost(url.hostname)
    );
  } catch {
    return false;
  }
}

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) {
    return false;
  }
  const actual = Buffer.from(provided, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (actual.length !== wanted.length) {
    return false;
  }
  return timingSafeEqual(actual, wanted);
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") {
    return undefined;
  }
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  sessionId?: string,
): void {
  const body = `${JSON.stringify(payload)}\n`;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
  if (sessionId !== undefined) {
    response.setHeader("Mcp-Session-Id", sessionId);
  }
  response.end(body);
}

function sendError(
  response: ServerResponse,
  status: number,
  code: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): void {
  for (const [key, value] of Object.entries(extraHeaders)) {
    response.setHeader(key, value);
  }
  sendJson(response, status, errorResponse(null, code, message));
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new Error("PAYLOAD_TOO_LARGE"));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

interface SessionStore {
  create: () => string;
  has: (id: string) => boolean;
  touch: (id: string) => void;
  remove: (id: string) => void;
}

function createSessionStore(): SessionStore {
  const sessions = new Map<string, number>();

  const evict = (): void => {
    if (sessions.size <= MAX_SESSIONS) {
      return;
    }
    const oldest = [...sessions.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest) {
      sessions.delete(oldest[0]);
    }
  };

  return {
    create: () => {
      const id = randomUUID();
      sessions.set(id, Date.now());
      evict();
      return id;
    },
    has: (id) => sessions.has(id),
    touch: (id) => {
      if (sessions.has(id)) {
        sessions.set(id, Date.now());
      }
    },
    remove: (id) => {
      sessions.delete(id);
    },
  };
}

async function dispatch(
  message: unknown,
  context: ToolContext,
  version: string,
): Promise<JsonRpcResponse | null> {
  if (!isJsonRpcRequest(message)) {
    return errorResponse(null, -32600, "Invalid JSON-RPC request.");
  }
  return handleMcpMessage(message, context, version);
}

export async function startMcpHttpServer(options: McpHttpOptions): Promise<McpHttpHandle> {
  const host = options.host ?? DEFAULT_MCP_HTTP_HOST;
  const port = options.port ?? DEFAULT_MCP_HTTP_PORT;
  const token = options.token;
  const allowedOrigins = options.allowedOrigins ?? [];
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const version = options.serverVersion ?? MEMO_LOG_VERSION;

  if (!isLoopbackHost(host) && (token === undefined || token.length === 0)) {
    throw new CliError(
      `Refusing to bind MCP HTTP to non-loopback host "${host}" without a bearer token. Pass --token <token> or bind 127.0.0.1.`,
      ExitCode.ConfigError,
    );
  }

  const opened =
    options.index === undefined
      ? await openIndexStoreSafely(options.rootDir)
      : { store: null, warning: null };
  if (opened.warning !== null) {
    process.stderr.write(`WARN: ${opened.warning}\n`);
  }
  const index = options.index ?? opened.store ?? undefined;
  const context: ToolContext = {
    rootDir: options.rootDir,
    allowWrites: options.allowWrites === true,
    ...(options.engine !== undefined ? { engine: options.engine } : {}),
    ...(index !== undefined ? { index } : {}),
  };
  const sessions = createSessionStore();

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        sendError(
          response,
          500,
          -32603,
          error instanceof Error ? error.message : String(error),
        );
      } else {
        response.end();
      }
    });
  });

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${formatHostForUrl(host)}`);
    if (url.pathname !== MCP_HTTP_PATH) {
      sendError(response, 404, -32601, `Not found: ${url.pathname}`);
      return;
    }

    if (!originIsAllowed(request.headers.origin, allowedOrigins)) {
      sendError(response, 403, -32600, "Origin is not allowed.");
      return;
    }

    if (token !== undefined && token.length > 0) {
      if (!tokenMatches(bearerToken(request), token)) {
        sendError(response, 401, -32600, "Missing or invalid bearer token.", {
          "WWW-Authenticate": 'Bearer realm="memo-log"',
        });
        return;
      }
    }

    if (request.method === "GET") {
      // Server-initiated SSE streams are intentionally not offered.
      sendError(response, 405, -32601, "GET is not supported; use POST.", {
        Allow: "POST, DELETE",
      });
      return;
    }

    if (request.method === "DELETE") {
      const sessionId = request.headers["mcp-session-id"];
      if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
        sendError(response, 400, -32600, "Missing or unknown Mcp-Session-Id.");
        return;
      }
      sessions.remove(sessionId);
      response.statusCode = 204;
      response.end();
      return;
    }

    if (request.method !== "POST") {
      sendError(response, 405, -32601, "Method not allowed.", {
        Allow: "POST, DELETE",
      });
      return;
    }

    const contentType = request.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      sendError(response, 415, -32600, "Content-Type must be application/json.");
      return;
    }

    let raw: string;
    try {
      raw = await readBody(request, maxBodyBytes);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "PAYLOAD_TOO_LARGE";
      sendError(
        response,
        tooLarge ? 413 : 400,
        -32600,
        tooLarge ? "Request body is too large." : "Unable to read request body.",
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      sendError(
        response,
        400,
        -32700,
        `Parse error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    const isBatch = Array.isArray(parsed);
    const messages: unknown[] = isBatch ? (parsed as unknown[]) : [parsed];
    if (messages.length === 0) {
      sendError(response, 400, -32600, "Empty batch.");
      return;
    }

    const containsInitialize = messages.some(
      (message) => isJsonRpcRequest(message) && message.method === "initialize",
    );

    const sessionHeader = request.headers["mcp-session-id"];
    let sessionId: string;
    if (containsInitialize) {
      // A new initialize always starts a fresh session, even if a stale id was
      // supplied, so reconnecting clients cannot inherit another session.
      sessionId = sessions.create();
    } else {
      if (typeof sessionHeader !== "string" || !sessions.has(sessionHeader)) {
        sendError(
          response,
          400,
          -32600,
          "Missing or unknown Mcp-Session-Id. Send initialize first.",
        );
        return;
      }
      sessionId = sessionHeader;
      sessions.touch(sessionId);
    }

    const responses: JsonRpcResponse[] = [];
    for (const message of messages) {
      const result = await dispatch(message, context, version);
      if (result !== null) {
        responses.push(result);
      }
    }

    if (responses.length === 0) {
      response.statusCode = 202;
      response.setHeader("Mcp-Session-Id", sessionId);
      response.end();
      return;
    }

    sendJson(response, 200, isBatch ? responses : responses[0], sessionId);
  }

  return new Promise<McpHttpHandle>((resolve, reject) => {
    const onError = (error: Error): void => {
      opened.store?.close();
      reject(
        new CliError(
          `Unable to start MCP HTTP server on ${host}:${port}: ${error.message}`,
          ExitCode.RuntimeError,
        ),
      );
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      const actualPort =
        typeof address === "object" && address !== null ? address.port : port;
      resolve({
        server,
        host,
        port: actualPort,
        url: `http://${formatHostForUrl(host)}:${actualPort}${MCP_HTTP_PATH}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => {
              opened.store?.close();
              if (error) {
                closeReject(error);
                return;
              }
              closeResolve();
            });
            // Do not let idle keep-alive sockets keep the process alive.
            server.closeAllConnections();
          }),
      });
    });
  });
}
