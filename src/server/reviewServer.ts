// Local review server (F-10 / F-11 / F-13 / G-4 / G-5).
//
// Inbound only: binds 127.0.0.1, serves server-rendered pages from embedded
// assets, and makes no outbound request. The page is another caller of the
// same core functions the CLI and MCP use. It is the only file besides
// src/mcp/http.ts allowed to import node:http.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename } from "node:path";
import type { Duplex } from "node:stream";

import { loadCards } from "../engine/cards.js";
import { listAttributionSpans } from "../engine/attribution.js";
import { CliError } from "../engine/errors.js";
import { buildGraph } from "../engine/graph.js";
import { onReviewSignal } from "../engine/reviewSignals.js";
import {
  markChecklistItem,
  transitionTicket,
} from "../engine/ticketCommands.js";
import { isTicketId, loadTicket, loadTickets } from "../engine/tickets.js";
import { MERMAID_JS, REVIEW_CSS, REVIEW_JS } from "./reviewAssets.js";
import {
  renderBoard,
  renderCards,
  renderGraph,
  renderInbox,
  renderContext,
  renderNotFound,
  renderTicket,
  renderTokenPrompt,
  type PageContext,
  type TicketFilters,
} from "./reviewPages.js";

export const REVIEW_LOOPBACK_HOST = "127.0.0.1";
export const DEFAULT_REVIEW_IDLE_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const REVIEW_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:*",
  "font-src 'none'",
  "form-action 'self'",
  "base-uri 'none'",
].join("; ");

export interface ReviewServerOptions {
  rootDir: string;
  /** 0 picks a random free port. */
  port?: number | undefined;
  allowWrites?: boolean | undefined;
  idleTimeoutMs?: number | undefined;
  /** Override for tests. */
  token?: string | undefined;
}

export interface ReviewServerHandle {
  server: Server;
  host: string;
  port: number;
  token: string;
  /** Entry URL including the token. */
  url: string;
  allowWrites: boolean;
  /** Broadcast a signal-only WebSocket frame `{"type":"changed","target","hash"}` to connected tabs. */
  notifyChange(target: string, hash: string): void;
  /** Resolves when the server closes (idle timeout or `close()`). */
  closed: Promise<void>;
  close(): Promise<void>;
}

function encodeWsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  if (len < 126) {
    return Buffer.concat([Buffer.from([0x81, len]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(len, 2);
  return Buffer.concat([header, payload]);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function baseHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Content-Security-Policy": REVIEW_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, baseHeaders(contentType));
  res.end(body);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { ...baseHeaders("text/plain; charset=utf-8"), Location: location });
  res.end();
}

function ticketFilters(url: URL): TicketFilters {
  const rawPriority = url.searchParams.get("priority") ?? "";
  const priority = ["urgent", "high", "medium", "low"].includes(rawPriority) ? rawPriority : "";
  return {
    q: (url.searchParams.get("q") ?? "").slice(0, 200),
    priority,
    category: (url.searchParams.get("category") ?? "").slice(0, 120),
  };
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  const type = String(req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") {
    return null;
  }
  return await new Promise<URLSearchParams | null>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? null : new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", () => resolve(null));
  });
}

export async function startReviewServer(options: ReviewServerOptions): Promise<ReviewServerHandle> {
  const token = options.token ?? randomBytes(16).toString("hex");
  const allowWrites = options.allowWrites === true;
  const idleMs = options.idleTimeoutMs ?? DEFAULT_REVIEW_IDLE_MS;
  const projectName = basename(options.rootDir) || "project";
  let boundPort = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  const wsClients = new Set<Duplex>();
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const notifyChange = (target: string, hash: string): void => {
    const frame = encodeWsTextFrame(JSON.stringify({ type: "changed", target, hash }));
    for (const sock of wsClients) {
      try {
        sock.write(frame);
      } catch {
        wsClients.delete(sock);
      }
    }
  };
  const stopSignals = onReviewSignal(options.rootDir, notifyChange);

  const armIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (idleMs > 0) {
      idleTimer = setTimeout(() => {
        void handle.close();
      }, idleMs);
    }
  };

  const hostAllowed = (hostHeader: string | undefined): boolean =>
    hostHeader === `${REVIEW_LOOPBACK_HOST}:${boundPort}` || hostHeader === `localhost:${boundPort}`;
  const originAllowed = (origin: string | undefined): boolean =>
    origin === `http://${REVIEW_LOOPBACK_HOST}:${boundPort}` || origin === `http://localhost:${boundPort}`;

  const context = async (base: string, flash?: PageContext["flash"]): Promise<PageContext> => ({
    base,
    allowWrites,
    rootDir: options.rootDir,
    tickets: loadTickets(options.rootDir),
    cards: loadCards(options.rootDir),
    attributions: await listAttributionSpans(options.rootDir),
    projectName,
    jsonPath: "MEMO_LOG.json",
    flash,
    active: "inbox",
  });

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    armIdle();
    if (!hostAllowed(req.headers.host)) {
      send(res, 403, "text/plain; charset=utf-8", "Forbidden: unexpected Host header.");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${REVIEW_LOOPBACK_HOST}:${boundPort}`);

    if (url.pathname === "/" && req.method === "GET") {
      const supplied = url.searchParams.get("token") ?? "";
      if (supplied.length > 0 && safeEqual(supplied, token)) {
        redirect(res, `/t/${token}/inbox`);
      } else {
        send(res, 401, "text/html; charset=utf-8", renderTokenPrompt());
      }
      return;
    }
    if (url.pathname === "/app.css" && req.method === "GET") {
      send(res, 200, "text/css; charset=utf-8", REVIEW_CSS);
      return;
    }

    const match = /^\/t\/([^/]+)\/(.*)$/.exec(url.pathname);
    if (!match || !safeEqual(match[1] ?? "", token)) {
      send(res, 404, "text/plain; charset=utf-8", "Not found.");
      return;
    }
    const base = `/t/${token}/`;
    const route = (match[2] ?? "").replace(/\/+$/, "");

    if (req.method === "POST") {
      if (!originAllowed(req.headers.origin)) {
        send(res, 403, "text/plain; charset=utf-8", "Forbidden: cross-origin request.");
        return;
      }
      if (!allowWrites) {
        send(res, 403, "text/plain; charset=utf-8", "Writes are disabled. Restart with --allow-writes.");
        return;
      }
      const action = /^ticket\/(T-[0-9a-f]{12})\/(approve|bounce|reopen|check|uncheck)$/.exec(route);
      if (!action) {
        send(res, 404, "text/plain; charset=utf-8", "Not found.");
        return;
      }
      const form = await readForm(req);
      if (form === null) {
        send(res, 400, "text/plain; charset=utf-8", "Bad request body.");
        return;
      }
      const ticketId = action[1] as string;
      const kind = action[2] as string;
      let message = "";
      let error = false;
      let target = `${base}inbox`;
      try {
        const current = loadTicket(options.rootDir, ticketId);
        if (!current) {
          throw new CliError(`Ticket not found: ${ticketId}`, 2);
        }
        if (kind === "approve") {
          const next = transitionTicket({
            rootDir: options.rootDir,
            ticketId,
            action: current.state === "open" ? "accept" : "done",
          });
          message = `${ticketId} → ${next.ticket.state}`;
        } else if (kind === "bounce") {
          transitionTicket({
            rootDir: options.rootDir,
            ticketId,
            action: "block",
            reason: form.get("reason") ?? "",
          });
          message = `${ticketId} blocked`;
        } else if (kind === "reopen") {
          transitionTicket({ rootDir: options.rootDir, ticketId, action: "reopen" });
          message = `${ticketId} reopened`;
        } else {
          target = `${base}ticket/${ticketId}`;
          const result = markChecklistItem({
            rootDir: options.rootDir,
            ticketId,
            item: form.get("item") ?? "",
            status: kind === "check" ? "done" : "pending",
            evidence: form.get("evidence") ?? undefined,
          });
          message = `${result.item.id} → ${result.item.status}`;
        }
      } catch (caught) {
        error = true;
        message = caught instanceof Error ? caught.message : String(caught);
        if (kind === "approve" || kind === "bounce" || kind === "reopen") {
          target = `${base}ticket/${ticketId}`;
        }
        redirect(res, `${target}?f=${encodeURIComponent(message.slice(0, 300))}&e=1`);
        return;
      }
      try {
        const newGraph = buildGraph({ rootDir: options.rootDir });
        notifyChange(ticketId, newGraph.integrityHash);
      } catch (caught) {
        const detail = caught instanceof Error ? caught.message : String(caught);
        message = `${message}. Ticket saved; graph refresh failed: ${detail}`;
      }
      redirect(res, `${target}?f=${encodeURIComponent(message.slice(0, 300))}${error ? "&e=1" : ""}`);
      return;
    }

    if (req.method !== "GET") {
      send(res, 405, "text/plain; charset=utf-8", "Method not allowed.");
      return;
    }

    if (route === "app.css") {
      send(res, 200, "text/css; charset=utf-8", REVIEW_CSS);
      return;
    }
    if (route === "app.js") {
      send(res, 200, "text/javascript; charset=utf-8", REVIEW_JS);
      return;
    }
    if (route === "mermaid.js") {
      send(res, 200, "text/javascript; charset=utf-8", MERMAID_JS);
      return;
    }
    if (route === "graph.json") {
      const g = buildGraph({ rootDir: options.rootDir });
      send(res, 200, "application/json; charset=utf-8", JSON.stringify(g));
      return;
    }

    const flashText = url.searchParams.get("f");
    const flash = flashText !== null ? { text: flashText.slice(0, 300), error: url.searchParams.get("e") === "1" } : undefined;
    const ctx = await context(base, flash);

    try {
      if (route === "" || route === "inbox") {
        send(res, 200, "text/html; charset=utf-8", renderInbox(ctx, ticketFilters(url)));
      } else if (route === "list") {
        // The List view became Context; keep old bookmarks working.
        res.writeHead(302, { Location: `${base}context` });
        res.end();
      } else if (route === "context") {
        send(res, 200, "text/html; charset=utf-8", renderContext(ctx, (url.searchParams.get("file") ?? "").slice(0, 200)));
      } else if (route === "board") {
        send(res, 200, "text/html; charset=utf-8", renderBoard(ctx, ticketFilters(url)));
      } else if (route === "cards") {
        send(res, 200, "text/html; charset=utf-8", renderCards(ctx));
      } else if (route === "graph") {
        const seedParam = url.searchParams.get("seed") ?? undefined;
        const depthRaw = url.searchParams.get("depth");
        const depth = depthRaw !== null ? Number(depthRaw) : 1;
        send(
          res,
          200,
          "text/html; charset=utf-8",
          renderGraph(ctx, { rootDir: options.rootDir, seed: seedParam, depth }),
        );
      } else if (route.startsWith("ticket/")) {
        const id = route.slice("ticket/".length);
        const ticket = isTicketId(id) ? loadTicket(options.rootDir, id) : null;
        if (!ticket) {
          send(res, 404, "text/html; charset=utf-8", renderNotFound(ctx, "No ticket with that id."));
        } else {
          send(res, 200, "text/html; charset=utf-8", renderTicket(ctx, ticket));
        }
      } else {
        send(res, 404, "text/html; charset=utf-8", renderNotFound(ctx, "No such page."));
      }
    } catch (caught) {
      send(
        res,
        500,
        "text/plain; charset=utf-8",
        caught instanceof Error ? caught.message : "Internal error.",
      );
    }
  };

  const server = createServer((req, res) => {
    void handler(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", "Internal error.");
      else res.end();
    });
  });

  server.on("upgrade", (req, socket) => {
    armIdle();
    if (!hostAllowed(req.headers.host) || !originAllowed(req.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", `http://${REVIEW_LOOPBACK_HOST}:${boundPort}`);
    const match = /^\/t\/([^/]+)\/ws$/.exec(url.pathname);
    if (!match || !safeEqual(match[1] ?? "", token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || key.length === 0) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"),
    );
    wsClients.add(socket);
    const cleanup = (): void => {
      wsClients.delete(socket);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    socket.on("end", cleanup);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(new CliError(`Unable to start review server on ${REVIEW_LOOPBACK_HOST}: ${error.message}`, 4));
    };
    server.once("error", onError);
    server.listen(options.port ?? 0, REVIEW_LOOPBACK_HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new CliError("Review server did not report a port.", 4);
  }
  boundPort = address.port;
  armIdle();

  let closing: Promise<void> | undefined;
  const handle: ReviewServerHandle = {
    server,
    host: REVIEW_LOOPBACK_HOST,
    port: boundPort,
    token,
    url: `http://${REVIEW_LOOPBACK_HOST}:${boundPort}/?token=${token}`,
    allowWrites,
    notifyChange,
    closed,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        stopSignals();
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        for (const sock of wsClients) {
          sock.destroy();
        }
        wsClients.clear();
        server.close(() => {
          resolveClosed();
          resolve();
        });
        server.closeAllConnections();
      });
      return closing;
    },
  };
  return handle;
}
