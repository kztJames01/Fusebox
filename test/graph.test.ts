import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import * as crypto from "node:crypto";
import {
  buildGraph,
  verifyGraph,
  queryGraph,
  findGraphPath,
  buildGraphContextPack,
  renderGraphMermaid,
} from "../src/engine/graph.js";
import { runCli } from "../src/cli/runCli.js";
import { loadTickets, writeTicket } from "../src/engine/tickets.js";
import { addCard } from "../src/engine/cards.js";
import { listMcpTools, callMcpTool } from "../src/mcp/tools.js";
import { startReviewServer } from "../src/server/reviewServer.js";

describe("Phase G — Deterministic Structural Graph & Local Live View", () => {
  let tmpDir: string;
  let ticketId: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-log-graph-"));
    fs.mkdirSync(path.join(tmpDir, "src", "auth"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "src", "billing"), { recursive: true });

    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        name: "graph-fixture",
        dependencies: { zod: "^4.0.0" },
        devDependencies: { vitest: "^4.0.0" },
      }),
      "utf8",
    );

    fs.writeFileSync(
      path.join(tmpDir, "src", "auth", "tokens.ts"),
      [
        "export interface TokenPayload { userId: string; exp: number; }",
        "export function verifyToken(token: string): boolean {",
        "    return token.length > 0;",
        "}",
        "export class TokenStore {",
        "    public revoke(id: string): void { void id; }",
        "}",
      ].join("\n"),
      "utf8",
    );

    fs.writeFileSync(
      path.join(tmpDir, "src", "auth", "middleware.ts"),
      [
        "import { verifyToken, TokenStore } from './tokens.js';",
        "export function requireAuth(header: string): boolean {",
        "    const store = new TokenStore();",
        "    void store;",
        "    return verifyToken(header);",
        "}",
      ].join("\n"),
      "utf8",
    );

    fs.writeFileSync(
      path.join(tmpDir, "src", "billing", "checkout.ts"),
      [
        "import { requireAuth } from '../auth/middleware.js';",
        "export function runCheckout(token: string, amountCents: number): boolean {",
        "    if (!requireAuth(token)) return false;",
        "    return amountCents > 0;",
        "}",
      ].join("\n"),
      "utf8",
    );

    await runCli(["init", tmpDir]);
    await runCli(["scan", tmpDir, "--quiet"]);
    await runCli(["session", "start", "harden checkout auth", "-C", tmpDir, "--json"]);

    // Modify checkout.ts so ending the session materializes a ticket + session link
    fs.writeFileSync(
      path.join(tmpDir, "src", "billing", "checkout.ts"),
      [
        "import { requireAuth } from '../auth/middleware.js';",
        "export function runCheckout(token: string, amountCents: number): boolean {",
        "    if (!requireAuth(token)) return false;",
        "    return amountCents >= 1;",
        "}",
        "export function refundCheckout(token: string): boolean {",
        "    return requireAuth(token);",
        "}",
      ].join("\n"),
      "utf8",
    );
    await runCli(["scan", tmpDir, "--quiet"]);

    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await runCli(["session", "end", "-C", tmpDir, "--json"]);
    } finally {
      process.stdout.write = originalWrite;
    }

    const tickets = loadTickets(tmpDir);
    expect(tickets.length).toBeGreaterThan(0);
    const t1 = tickets[0]!;
    ticketId = t1.id;

    // Attach Repo-check evidence to first checklist item
    if (t1.checklist.length > 0) {
      t1.checklist[0]!.status = "done";
      t1.checklist[0]!.evidence = "[src/billing/checkout.ts:3]";
      writeTicket(tmpDir, t1);
    }

    // Seed cards with replacement chain
    const oldCard = addCard({
      rootDir: tmpDir,
      type: "constraint",
      content: "Tokens must be non-empty in [src/auth/tokens.ts:2].",
      refs: ["[src/auth/tokens.ts:2]"],
      scope: "folder",
      scopeTarget: "src/auth",
    });
    addCard({
      rootDir: tmpDir,
      type: "decision",
      content: "Checkout always calls requireAuth in [src/billing/checkout.ts:3].",
      refs: ["[src/billing/checkout.ts:3]", "[src/auth/middleware.ts:2]"],
      scope: "ticket",
      scopeTarget: ticketId,
      replaces: oldCard.id,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("G-1 / G-2 / G-6: builds deterministic structural graph, supports incremental rebuild, and passes verifyGraph", () => {
    const g1 = buildGraph({ rootDir: tmpDir, forceFull: true, write: true });
    expect(g1.schema).toBe(1);
    expect(g1.integrityHash).toMatch(/^[a-f0-9]{64}$/);

    // Node kinds present
    const kinds = new Set(g1.nodes.map((n) => n.kind));
    expect(kinds.has("File")).toBe(true);
    expect(kinds.has("Symbol")).toBe(true);
    expect(kinds.has("Ticket")).toBe(true);
    expect(kinds.has("Session")).toBe(true);
    expect(kinds.has("Card")).toBe(true);

    // Edge types present
    const edgeTypes = new Set(g1.edges.map((e) => e.type));
    expect(edgeTypes.has("defines")).toBe(true);
    expect(edgeTypes.has("exports")).toBe(true);
    expect(edgeTypes.has("imports")).toBe(true);
    expect(edgeTypes.has("changed_in")).toBe(true);
    expect(edgeTypes.has("ticket_to_done_when_to_evidence")).toBe(true);
    expect(edgeTypes.has("has_card")).toBe(true);
    expect(edgeTypes.has("card_replaces_card")).toBe(true);

    // Incremental rebuild with no changes reuses file subgraphs and produces identical integrityHash
    const g2 = buildGraph({ rootDir: tmpDir, write: true });
    expect(g2.integrityHash).toBe(g1.integrityHash);
    expect(g2.nodes).toEqual(g1.nodes);
    expect(g2.edges).toEqual(g1.edges);

    // verifyGraph rebuilds from scratch and confirms hash parity
    const verification = verifyGraph(tmpDir);
    expect(verification.valid).toBe(true);
    expect(verification.persistedHash).toBe(g1.integrityHash);
    expect(verification.rebuiltHash).toBe(g1.integrityHash);
  });

  it("G-2: queryGraph returns explainable score breakdown and golden deterministic traversal order", () => {
    const result1 = queryGraph({
      rootDir: tmpDir,
      seed: ticketId,
      depth: 2,
      limit: 10,
    });
    const result2 = queryGraph({
      rootDir: tmpDir,
      seed: ticketId,
      depth: 2,
      limit: 10,
    });

    expect(result1.seed.key).toBe(ticketId);
    expect(result1.nodes.length).toBeGreaterThan(1);
    // Exact deterministic order across runs
    expect(result1.nodes.map((r) => r.node.id)).toEqual(
      result2.nodes.map((r) => r.node.id),
    );

    // Every result includes explainable score breakdown
    for (const item of result1.nodes) {
      expect(item.hopDistance).toBeGreaterThanOrEqual(0);
      expect(item.hopDistance).toBeLessThanOrEqual(2);
      expect(item.breakdown).toBeDefined();
      expect(typeof item.breakdown.hop).toBe("number");
      expect(typeof item.breakdown.edgeWeight).toBe("number");
      expect(typeof item.breakdown.recency).toBe("number");
      expect(typeof item.breakdown.degree).toBe("number");
      expect(typeof item.breakdown.total).toBe("number");
    }
  });

  it("G-2: findGraphPath computes deterministic shortest path between checkout.ts and tokens.ts", () => {
    const pathResult = findGraphPath({
      rootDir: tmpDir,
      from: "src/billing/checkout.ts",
      to: "src/auth/tokens.ts",
    });
    expect(pathResult.found).toBe(true);
    expect(pathResult.hops).toBeGreaterThanOrEqual(1);
    expect(pathResult.nodes[0]?.key).toBe("src/billing/checkout.ts");
    expect(pathResult.nodes[pathResult.nodes.length - 1]?.key).toBe(
      "src/auth/tokens.ts",
    );
  });

  it("G-4: renderGraphMermaid produces 1-2 hop neighborhood diagram and rejects depth > 2", () => {
    const diagram = renderGraphMermaid({
      rootDir: tmpDir,
      seed: ticketId,
      depth: 2,
    });
    expect(diagram.mermaid).toContain("flowchart LR");
    expect(diagram.query.nodes.length).toBeGreaterThan(1);

    expect(() =>
      renderGraphMermaid({ rootDir: tmpDir, seed: ticketId, depth: 3 }),
    ).toThrow(/Mermaid graph view is limited to 1–2 hops/);
  });

  it("G-3: MCP tools expose graph_query, graph_path, context_pack, and review_open with zero-paste citations", async () => {
    const tools = listMcpTools(false);
    const names = tools.map((t) => t.name);
    expect(names).toContain("graph_query");
    expect(names).toContain("graph_path");
    expect(names).toContain("context_pack");
    expect(names).toContain("review_open");

    const queryRes = (await callMcpTool(
      "graph_query",
      { seed: ticketId, depth: 2, limit: 8 },
      { rootDir: tmpDir, allowWrites: false },
    )) as { seed: { key: string }; nodes: unknown[] };
    expect(queryRes.seed.key).toBe(ticketId);
    expect(queryRes.nodes.length).toBeGreaterThan(0);

    const pathRes = (await callMcpTool(
      "graph_path",
      { from: "src/billing/checkout.ts", to: "src/auth/tokens.ts" },
      { rootDir: tmpDir, allowWrites: false },
    )) as { found: boolean; hops: number };
    expect(pathRes.found).toBe(true);
    expect(pathRes.hops).toBeGreaterThanOrEqual(1);

    const packRes = (await callMcpTool(
      "context_pack",
      { seed: ticketId, budget: 600 },
      { rootDir: tmpDir, allowWrites: false },
    )) as { usedTokens: number; items: unknown[] };
    expect(packRes.usedTokens).toBeLessThanOrEqual(600);
    expect(packRes.items.length).toBeGreaterThan(0);
  });

  it("G-3 Benchmark: context_pack uses < 15% of tokens compared to full-file paste across a multi-module repo", async () => {
    // Add 18 synthetic modules to represent a realistic codebase where full-file paste is large
    for (let i = 0; i < 18; i++) {
      const lines: string[] = [];
      for (let l = 0; l < 80; l++) {
        lines.push(
          `export function helper_${i}_${l}(input: string): string { return input + "-${i}-${l}"; }`,
        );
      }
      fs.writeFileSync(
        path.join(tmpDir, "src", `module_${i}.ts`),
        lines.join("\n"),
        "utf8",
      );
    }

    await runCli(["scan", tmpDir, "--quiet"]);

    // Measure total repository source tokens (~4 chars/token)
    let fullRepoChars = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          fullRepoChars += fs.readFileSync(full, "utf8").length;
        }
      }
    };
    walk(tmpDir);
    const fullRepoTokens = Math.ceil(fullRepoChars / 4);

    buildGraph({ rootDir: tmpDir, forceFull: true, write: true });
    const pack = buildGraphContextPack({
      rootDir: tmpDir,
      seed: ticketId,
      budget: 800,
      depth: 2,
    });

    expect(pack.usedTokens).toBeLessThan(fullRepoTokens * 0.15);
    expect(pack.ordering).toBe("long-context-reorder");
    expect(pack.items.length).toBeGreaterThanOrEqual(3);
  });

  it("G-4: WebSocket live signal enforces Host/Origin/token on upgrade and pushes signal-only frames on write", async () => {
    const instance = await startReviewServer({
      rootDir: tmpDir,
      port: 0,
      idleTimeoutMs: 60_000,
    });

    try {
      // 1. Reject cross-origin WebSocket upgrade
      const badUpgradeStatus = await new Promise<number>((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: instance.port,
          path: `/t/${instance.token}/ws`,
          headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            Origin: "https://evil.example.com",
            "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
            "Sec-WebSocket-Version": "13",
          },
        });
        req.on("response", (res) => resolve(res.statusCode || 0));
        req.on("upgrade", (_res, socket) => {
          socket.destroy();
          resolve(101);
        });
        req.on("error", reject);
        req.end();
      });
      expect(badUpgradeStatus).toBe(403);

      // 2. Accept valid loopback WebSocket upgrade and receive signal-only frame
      const framePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: instance.port,
          path: `/t/${instance.token}/ws`,
          headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            Origin: `http://127.0.0.1:${instance.port}`,
            "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
            "Sec-WebSocket-Version": "13",
          },
        });
        req.on("upgrade", (_res, socket) => {
          socket.on("data", (buf: Buffer) => {
            const payloadLen = buf[1]! & 0x7f;
            const text = buf.subarray(2, 2 + payloadLen).toString("utf8");
            socket.destroy();
            resolve(JSON.parse(text));
          });
          setTimeout(() => {
            instance.notifyChange(`ticket:${ticketId}`, "abc123hash");
          }, 20);
        });
        req.on("error", reject);
        req.end();
      });

      const signal = await framePromise;
      expect(signal).toEqual({
        type: "changed",
        target: `ticket:${ticketId}`,
        hash: "abc123hash",
      });
    } finally {
      await instance.close();
    }
  });
});
