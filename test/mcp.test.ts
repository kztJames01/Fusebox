import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";
import { runMcpServer } from "../src/mcp/server.js";
import { MCP_TOOLS } from "../src/mcp/tools.js";
import { loadTicket } from "../src/engine/tickets.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    chunks,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

async function createFixture(): Promise<{ root: string; ticketId: string; sessionId: string }> {
  const root = await makeTempDir("memolog-mcp-");
  await runCli(["init", root]);
  await writeFile(root, "src/auth/login.ts", "export function login(email: string) { return email; }\n");
  await runCli(["scan", root, "--format", "both", "--quiet"]);

  const startCapture = captureStdout();
  try {
    await runCli(["session", "start", "mcp fixture", "-C", root, "--json"]);
  } finally {
    startCapture.restore();
  }
  const started = JSON.parse(startCapture.chunks.join("").trim()) as { id: string };

  await writeFile(
    root,
    "src/auth/login.ts",
    [
      "export function login(email: string, password: string) { return email && password; }",
      "export function logout() {}",
      "",
    ].join("\n"),
  );

  const endCapture = captureStdout();
  try {
    await runCli(["session", "end", "-C", root, "--json"]);
  } finally {
    endCapture.restore();
  }
  const ended = JSON.parse(endCapture.chunks.join("").trim()) as {
    ticket: { id: string };
  };
  return { root, ticketId: ended.ticket.id, sessionId: started.id };
}

interface RpcResult {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

async function exchange(
  rootDir: string,
  messages: unknown[],
  options: { allowWrites?: boolean } = {},
): Promise<{ responses: RpcResult[]; raw: string }> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer | string) => {
    chunks.push(String(chunk));
  });

  const server = runMcpServer({
    rootDir,
    input,
    output,
    serverVersion: "test",
    ...(options.allowWrites === true ? { allowWrites: true } : {}),
  });
  for (const message of messages) {
    input.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`);
  }
  input.end();
  await server;

  const raw = chunks.join("");
  const responses = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RpcResult);
  return { responses, raw };
}

describe("MCP server", () => {
  it("initializes, lists read-only tools, and answers read tools over stdio", async () => {
    const { root, ticketId, sessionId } = await createFixture();
    const itemId = loadTicket(root, ticketId)!.checklist[0]!.id;

    const { responses, raw } = await exchange(root, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "list_recent_tickets", arguments: { limit: 5 } },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "get_ticket", arguments: { ticketId } },
      },
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "query_context", arguments: { category: "auth", limit: 5 } },
      },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "get_session_summary", arguments: { sessionId } },
      },
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "mark_checklist_item", arguments: { ticketId, item: itemId, status: "done" } },
      },
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "get_ticket", arguments: { ticketId: "T-000000000000" } },
      },
    ]);

    // stdout contains protocol messages only.
    expect(raw.trim().split("\n").every((line) => line.startsWith("{"))).toBe(true);

    const byId = new Map(responses.map((response) => [response.id, response]));
    expect(byId.get(1)?.result).toMatchObject({
      protocolVersion: "2025-03-26",
      serverInfo: { name: "memo-log", version: "test" },
    });
    expect(byId.get(2)?.result).toEqual({});

    const tools = (byId.get(3)?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      "inbox",
      "board",
      "context",
      "graph",
      "ticket_list",
      "ticket_summary",
      "ticket_group",
      "list_recent_tickets",
      "get_ticket",
      "query_context",
      "get_session_summary",
      "list_cards",
      "get_card",
      "graph_query",
      "graph_path",
      "context_pack",
      "verify_claims",
      "review_open",
    ]);

    const listPayload = JSON.parse(
      (byId.get(4)?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { tickets: Array<{ id: string; references: string[] }> };
    expect(listPayload.tickets.map((ticket) => ticket.id)).toContain(ticketId);
    expect(listPayload.tickets[0]?.references.every((ref) => ref.startsWith("["))).toBe(true);

    const ticketPayload = JSON.parse(
      (byId.get(5)?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { ticket: { id: string } };
    expect(ticketPayload.ticket.id).toBe(ticketId);

    const queryPayload = JSON.parse(
      (byId.get(6)?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { kind: string; entries: Array<{ ref: string; category: string }> };
    expect(queryPayload.kind).toBe("memo-log-query");
    expect(queryPayload.entries.every((entry) => entry.ref.startsWith("[src/auth/"))).toBe(true);
    expect(queryPayload.entries.every((entry) => entry.category === "auth")).toBe(true);

    const sessionPayload = JSON.parse(
      (byId.get(7)?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { session: { id: string }; ticket: { id: string }; ticketCounts: Record<string, number> };
    expect(sessionPayload.session.id).toBe(sessionId);
    expect(sessionPayload.ticket.id).toBe(ticketId);
    expect(sessionPayload.ticketCounts.open).toBe(1);

    const markPayload = byId.get(8)?.result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(markPayload.isError).toBe(true);
    expect(markPayload.content[0]?.text).toContain("disabled");
    expect(loadTicket(root, ticketId)?.checklist[0]?.status).toBe("pending");

    const missing = byId.get(9)?.result as { isError: boolean; content: Array<{ text: string }> };
    expect(missing.isError).toBe(true);
    expect(missing.content[0]?.text).toContain("Ticket not found");
  });

  it("serves its own protocol version instead of echoing the client", async () => {
    const root = await makeTempDir("memolog-mcp-protocol-");
    await runCli(["init", root]);

    const { responses } = await exchange(root, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "9999-01-01" },
      },
    ]);

    expect((responses[0]?.result as { protocolVersion: string }).protocolVersion).toBe(
      "2025-03-26",
    );
  });

  it("never responds to JSON-RPC notifications", async () => {
    const root = await makeTempDir("memolog-mcp-notifications-");
    await runCli(["init", root]);

    const { responses } = await exchange(root, [
      { jsonrpc: "2.0", method: "notifications/unknown" },
    ]);

    expect(responses).toHaveLength(0);
  });

  it("exposes and executes the write tool only with allowWrites", async () => {
    const { root, ticketId } = await createFixture();
    const itemId = loadTicket(root, ticketId)!.checklist[0]!.id;

    const { responses } = await exchange(
      root,
      [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "mark_checklist_item",
            arguments: { ticketId, item: itemId, status: "done", evidence: "[src/auth/login.ts:1]" },
          },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "mark_checklist_item",
            arguments: { ticketId, item: "2", status: "done" },
          },
        },
      ],
      { allowWrites: true },
    );

    const byId = new Map(responses.map((response) => [response.id, response]));
    const tools = (byId.get(1)?.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toContain("mark_checklist_item");

    const markPayload = JSON.parse(
      (byId.get(2)?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { changed: boolean; item: { status: string } };
    expect(markPayload.changed).toBe(true);
    expect(markPayload.item.status).toBe("done");
    expect(loadTicket(root, ticketId)?.checklist[0]?.status).toBe("done");
    expect(loadTicket(root, ticketId)?.checklist[0]?.evidence).toBe("[src/auth/login.ts:1]");
    expect((byId.get(3)?.result as { isError?: boolean } | undefined)?.isError ?? true).toBe(true);
  });

  it("returns protocol errors without crashing", async () => {
    const root = await makeTempDir("memolog-mcp-errors-");
    await runCli(["init", root]);

    const { responses } = await exchange(root, [
      "{not json",
      { jsonrpc: "2.0", id: 1, method: "unknown/method" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nope", arguments: {} } },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_recent_tickets", arguments: { limit: 0 } },
      },
    ]);

    const byId = new Map(responses.map((response) => [response.id, response]));
    expect(responses[0]?.error?.code).toBe(-32700);
    expect(byId.get(1)?.error?.code).toBe(-32601);
    expect(byId.get(2)?.error?.code).toBe(-32602);
    const invalidArgs = byId.get(3)?.result as { isError: boolean };
    expect(invalidArgs.isError).toBe(true);
  });

  it("serves view-first tools from the same deterministic review model", async () => {
    const { root, ticketId } = await createFixture();
    const groupId = loadTicket(root, ticketId)!.groups[0]!.id;

    const { responses } = await exchange(root, [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox", arguments: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "board", arguments: {} } },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "context", arguments: { limit: 5 } },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "graph", arguments: { op: "query", seed: "src/auth/login.ts" } },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "ticket_list", arguments: { limit: 5 } },
      },
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "ticket_summary", arguments: { ticketId } },
      },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "ticket_group", arguments: { ticketId, groupId } },
      },
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "verify_claims", arguments: { ticketId, claims: [{ text: "x" }] } },
      },
    ]);

    const byId = new Map(responses.map((response) => [response.id, response]));
    const payload = (id: number): Record<string, unknown> =>
      JSON.parse(
        (byId.get(id)?.result as { content: Array<{ text: string }> }).content[0]!.text,
      ) as Record<string, unknown>;

    const inbox = payload(1) as {
      kind: string;
      view: string;
      tickets: Array<{ id: string }>;
    };
    expect(inbox.kind).toBe("memo-log-mcp-inbox");
    expect(inbox.view).toBe("inbox");
    expect(inbox.tickets.map((row) => row.id)).toContain(ticketId);

    const board = payload(2) as { kind: string; columns: Array<{ state: string; count: number }> };
    expect(board.kind).toBe("memo-log-mcp-board");
    expect(board.columns.map((column) => column.state)).toEqual([
      "open",
      "needs_review",
      "blocked",
      "done",
    ]);

    const context = payload(3) as { kind: string; entries: Array<{ ref: string }> };
    expect(context.kind).toBe("memo-log-mcp-context");
    expect(context.entries.every((entry) => entry.ref.startsWith("["))).toBe(true);

    const graph = payload(4) as { kind: string; op: string };
    expect(graph.kind).toBe("memo-log-mcp-graph");
    expect(graph.op).toBe("query");

    const list = payload(5) as { tickets: Array<{ id: string }> };
    expect(list.tickets.map((row) => row.id)).toContain(ticketId);

    const summary = payload(6) as { ticket: { id: string; checklist: { total: number } } };
    expect(summary.ticket.id).toBe(ticketId);
    expect(summary.ticket.checklist.total).toBeGreaterThan(0);

    const group = payload(7) as { group: { id: string; audit: Array<{ ref: string }> } };
    expect(group.group.id).toBe(groupId);
    expect(group.group.audit.every((ref) => ref.ref.startsWith("["))).toBe(true);

    const claims = payload(8) as { status: string; claimCount: number };
    expect(claims.status).toBe("not_implemented");
    expect(claims.claimCount).toBe(1);
  });

  it("returns a deterministic not_implemented attribution payload only with allowWrites", async () => {
    const { root } = await createFixture();
    const args = {
      sessionId: "S-0123456789ab",
      agentId: "agent-1",
      path: "src/auth/login.ts",
      startLine: 1,
      endLine: 2,
    };

    const denied = await exchange(root, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "attribution_checkpoint", arguments: args },
      },
    ]);
    expect((denied.responses[0]?.result as { isError?: boolean }).isError).toBe(true);

    const allowed = await exchange(
      root,
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "attribution_checkpoint", arguments: args },
        },
      ],
      { allowWrites: true },
    );
    const payload = JSON.parse(
      (allowed.responses[0]?.result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as { status: string; span: { path: string; startLine: number } };
    expect(payload.status).toBe("not_implemented");
    expect(payload.span.path).toBe("src/auth/login.ts");
    expect(payload.span.startLine).toBe(1);
  });

  it("keeps the full MCP surface bounded and unique across view-first and legacy tools", () => {
    expect(MCP_TOOLS.length).toBeLessThanOrEqual(20);
    expect(new Set(MCP_TOOLS.map((tool) => tool.name)).size).toBe(MCP_TOOLS.length);
  });
});
