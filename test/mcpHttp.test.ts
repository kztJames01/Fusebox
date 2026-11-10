import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";
import {
  MCP_HTTP_PATH,
  startMcpHttpServer,
  type McpHttpHandle,
} from "../src/mcp/http.js";

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memolog-mcp-http-"));
  await runCli(["init", root]);
  return root;
}

function headers(session?: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(session !== undefined ? { "mcp-session-id": session } : {}),
    ...extra,
  };
}

async function initialize(
  handle: McpHttpHandle,
  extraHeaders: Record<string, string> = {},
): Promise<{ response: Awaited<ReturnType<typeof fetch>>; session: string }> {
  const response = await fetch(handle.url, {
    method: "POST",
    headers: headers(undefined, extraHeaders),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    }),
  });
  const session = response.headers.get("mcp-session-id") ?? "";
  return { response, session };
}

describe("MCP Streamable HTTP transport", () => {
  it("negotiates a session, lists tools, and terminates it with DELETE", async () => {
    const root = await makeRoot();
    const handle = await startMcpHttpServer({
      rootDir: root,
      host: "127.0.0.1",
      port: 0,
      serverVersion: "test",
    });

    try {
      expect(handle.url.endsWith(MCP_HTTP_PATH)).toBe(true);
      const { response, session } = await initialize(handle);
      expect(response.status).toBe(200);
      expect(session.length).toBeGreaterThan(0);

      const initBody = (await response.json()) as {
        result: { protocolVersion: string; serverInfo: { name: string } };
      };
      expect(initBody.result.protocolVersion).toBe("2025-03-26");
      expect(initBody.result.serverInfo.name).toBe("memo-log");

      const list = await fetch(handle.url, {
        method: "POST",
        headers: headers(session),
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      expect(list.status).toBe(200);
      const listBody = (await list.json()) as {
        result: { tools: Array<{ name: string }> };
      };
      expect(listBody.result.tools.map((tool) => tool.name)).toContain("query_context");

      const notification = await fetch(handle.url, {
        method: "POST",
        headers: headers(session),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      expect(notification.status).toBe(202);

      const missing = await fetch(handle.url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      });
      expect(missing.status).toBe(400);

      const deleted = await fetch(handle.url, {
        method: "DELETE",
        headers: { "mcp-session-id": session },
      });
      expect(deleted.status).toBe(204);

      const afterDelete = await fetch(handle.url, {
        method: "POST",
        headers: headers(session),
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
      });
      expect(afterDelete.status).toBe(400);
    } finally {
      await handle.close();
    }
  });

  it("accepts batch requests", async () => {
    const root = await makeRoot();
    const handle = await startMcpHttpServer({ rootDir: root, port: 0 });

    try {
      const response = await fetch(handle.url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
        ]),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBeTruthy();
      const body = (await response.json()) as Array<{ id: number }>;
      expect(body.map((entry) => entry.id)).toEqual([1, 2]);
    } finally {
      await handle.close();
    }
  });

  it("validates Origin and allows loopback plus explicit origins", async () => {
    const root = await makeRoot();
    const handle = await startMcpHttpServer({ rootDir: root, port: 0 });

    try {
      const blocked = await initialize(handle, { origin: "https://evil.example" });
      expect(blocked.response.status).toBe(403);

      const loopback = await initialize(handle, { origin: "http://localhost:5173" });
      expect(loopback.response.status).toBe(200);
    } finally {
      await handle.close();
    }

    const custom = await startMcpHttpServer({
      rootDir: root,
      port: 0,
      allowedOrigins: ["https://app.example"],
    });
    try {
      const allowed = await initialize(custom, { origin: "https://app.example" });
      expect(allowed.response.status).toBe(200);
      const stillBlocked = await initialize(custom, { origin: "https://other.example" });
      expect(stillBlocked.response.status).toBe(403);
    } finally {
      await custom.close();
    }
  });

  it("requires a bearer token when configured", async () => {
    const root = await makeRoot();
    const handle = await startMcpHttpServer({
      rootDir: root,
      port: 0,
      token: "correct-token",
    });

    try {
      const missing = await initialize(handle);
      expect(missing.response.status).toBe(401);
      expect(missing.response.headers.get("www-authenticate")).toContain("Bearer");

      const wrong = await initialize(handle, { authorization: "Bearer wrong" });
      expect(wrong.response.status).toBe(401);

      const correct = await initialize(handle, {
        authorization: "Bearer correct-token",
      });
      expect(correct.response.status).toBe(200);
      expect(correct.session.length).toBeGreaterThan(0);
    } finally {
      await handle.close();
    }
  });

  it("refuses non-loopback binds without a token", async () => {
    const root = await makeRoot();
    await expect(
      startMcpHttpServer({ rootDir: root, host: "0.0.0.0", port: 0 }),
    ).rejects.toThrow(/bearer token/i);
  });

  it("returns transport errors without crashing", async () => {
    const root = await makeRoot();
    const handle = await startMcpHttpServer({ rootDir: root, port: 0 });

    try {
      const get = await fetch(handle.url, { method: "GET" });
      expect(get.status).toBe(405);

      const notFound = await fetch(handle.url.replace(MCP_HTTP_PATH, "/nope"), {
        method: "POST",
        headers: headers(),
        body: "{}",
      });
      expect(notFound.status).toBe(404);

      const badType = await fetch(handle.url, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      });
      expect(badType.status).toBe(415);

      const badJson = await fetch(handle.url, {
        method: "POST",
        headers: headers(),
        body: "{not json",
      });
      expect(badJson.status).toBe(400);
      const badJsonBody = (await badJson.json()) as { error: { code: number } };
      expect(badJsonBody.error.code).toBe(-32700);
    } finally {
      await handle.close();
    }
  });
});
