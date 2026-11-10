// Minimal MCP server over stdio (JSON-RPC 2.0, newline-delimited).
//
// This is deliberately dependency-free and local-only. It implements the small
// surface agents need: initialize, tools/list, tools/call, and ping. Nothing is
// ever written to stdout except protocol messages, so it is safe to pipe into an
// MCP client.
import { createInterface } from "node:readline";

import { CliError } from "../engine/errors.js";
import { openIndexStoreSafely } from "../engine/indexStore.js";
import { callMcpTool, listMcpTools, MCP_TOOLS, type ToolContext } from "./tools.js";

export const MCP_PROTOCOL_VERSION = "2025-03-26";
export const MEMO_LOG_VERSION = "1.0.2";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export interface McpServerOptions extends ToolContext {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  /** Override for tests. */
  serverVersion?: string | undefined;
}

function send(output: NodeJS.WritableStream, response: JsonRpcResponse): void {
  output.write(`${JSON.stringify(response)}\n`);
}

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcFailure {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0" &&
    typeof (value as { method?: unknown }).method === "string"
  );
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return isRequest(value);
}

export async function handleMcpMessage(
  request: JsonRpcRequest,
  context: ToolContext,
  serverVersion = MEMO_LOG_VERSION,
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;

  switch (request.method) {
    case "initialize": {
      // Serve the protocol version this server implements. Echoing the client's
      // requested version would claim support for versions we do not handle.
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "memo-log", version: serverVersion },
          instructions:
            "Deterministic, reference-anchored project memory. Prefer query_context and get_ticket over reading whole files. Write tools are disabled unless the server was started with --allow-writes.",
        },
      };
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: listMcpTools(context.allowWrites === true) },
      };

    case "tools/call": {
      const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
      if (typeof params?.name !== "string") {
        return errorResponse(id, -32602, "tools/call requires a string `name`.");
      }
      // Validate against the full known surface so a client calling a known
      // write tool while writes are disabled gets the explicit "disabled"
      // error from `callMcpTool` instead of an opaque "unknown tool".
      if (!MCP_TOOLS.some((tool) => tool.name === params.name)) {
        return errorResponse(id, -32602, `Unknown tool: ${params.name}`);
      }

      try {
        const payload = await callMcpTool(params.name, params.arguments, context);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
            isError: false,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: message }],
            isError: true,
          },
        };
      }
    }

    case "exit":
      return null;

    default:
      // JSON-RPC notifications (no id) must never receive a response. Sending
      // one would desynchronize strict clients.
      if (request.id === undefined) {
        return null;
      }
      return errorResponse(id, -32601, `Method not found: ${request.method}`);
  }
}

export async function runMcpServer(options: McpServerOptions): Promise<void> {
  // Hold one read handle for the process lifetime instead of reopening the
  // database on every tool call. A missing index is fine; tools still read JSON.
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
  const version = options.serverVersion ?? MEMO_LOG_VERSION;

  const rl = createInterface({
    input: options.input,
    crlfDelay: Infinity,
    terminal: false,
  });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch (error) {
        send(
          options.output,
          errorResponse(
            null,
            -32700,
            `Parse error: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        continue;
      }

      if (!isRequest(parsed)) {
        send(options.output, errorResponse(null, -32600, "Invalid JSON-RPC request."));
        continue;
      }

      if (parsed.method === "exit") {
        break;
      }

      try {
        const response = await handleMcpMessage(parsed, context, version);
        if (response !== null) {
          send(options.output, response);
        }
      } catch (error) {
        const message = error instanceof CliError || error instanceof Error
          ? error.message
          : String(error);
        send(options.output, errorResponse(parsed.id ?? null, -32603, message));
      }
    }
  } finally {
    // Only close the handle this server opened; an injected store belongs to
    // the caller.
    opened.store?.close();
  }
}
