// Security gates. These fail the build if the interactive menu, MCP
// write tool, or source tree regresses the local-only guarantees.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";
import { saveSessionPrefs } from "../src/cli/sessionPrefs.js";
import { DEFAULT_MCP_HTTP_HOST, isLoopbackHost } from "../src/mcp/http.js";
import { callMcpTool, listMcpTools, MCP_TOOLS } from "../src/mcp/tools.js";
import { assertPathWithinRoot, SecurityPathError } from "../src/security/pathGuards.js";
import { loadTicket } from "../src/engine/tickets.js";

const NETWORK_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "fetch()", pattern: /\bfetch\s*\(/ },
  { label: "node:http(s)", pattern: /from\s+["']node:(?:http|https|http2)["']/ },
  { label: "node:net/tls/dgram", pattern: /from\s+["']node:(?:net|tls|dgram)["']/ },
  { label: "require http(s)", pattern: /require\(\s*["'](?:node:)?(?:http|https|http2)["']\s*\)/ },
  { label: "outbound http request", pattern: /\b(?:http|https)\.(?:request|get)\s*\(/ },
  { label: "outbound connect", pattern: /\b(?:net|tls)\.connect\s*\(/ },
  { label: "createConnection", pattern: /\bcreateConnection\s*\(/ },
  { label: "axios", pattern: /\baxios\b/ },
  { label: "undici", pattern: /\bundici\b/ },
  { label: "XMLHttpRequest", pattern: /\bXMLHttpRequest\b/ },
  { label: "WebSocket", pattern: /\bnew\s+WebSocket\b/ },
];

const INBOUND_HTTP_ALLOWLIST = new Set(["src/mcp/http.ts", "src/server/reviewServer.ts"]);
const INBOUND_NET_ALLOWLIST = new Set(["src/engine/serve.ts"]);

function collectTsFiles(directory: string): string[] {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

async function makeTempDir(prefix: string): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("security gates", () => {
  it("rejects outbound network APIs in src/ except the inbound MCP listener", () => {
    const violations: string[] = [];
    for (const file of collectTsFiles(path.resolve("src"))) {
      const relativeFile = path.relative(process.cwd(), file).split(path.sep).join("/");
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const { label, pattern } of NETWORK_PATTERNS) {
          if (INBOUND_HTTP_ALLOWLIST.has(relativeFile) && label === "node:http(s)") {
            continue;
          }
          if (INBOUND_NET_ALLOWLIST.has(relativeFile) && label === "node:net/tls/dgram") {
            continue;
          }
          if (pattern.test(line)) {
            violations.push(`${relativeFile}:${index + 1}: ${label}: ${line.trim()}`);
          }
          pattern.lastIndex = 0;
        }
      });
    }
    expect(violations).toEqual([]);
    expect(fs.existsSync("src/mcp/http.ts")).toBe(true);
    expect(fs.readFileSync("src/cli/interactiveMenu.ts", "utf8")).not.toMatch(/\bfetch\s*\(/);
    expect(fs.readFileSync("src/cli/sessionPrefs.ts", "utf8")).not.toMatch(/\bfetch\s*\(/);
  });

  it("keeps mark_checklist_item disabled unless allowWrites is set", async () => {
    expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([
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
      "mark_checklist_item",
      "attribution_checkpoint",
    ]);
    expect(listMcpTools(false).map((tool) => tool.name)).not.toContain("mark_checklist_item");
    expect(listMcpTools(false).map((tool) => tool.name)).not.toContain("attribution_checkpoint");
    expect(listMcpTools(true).map((tool) => tool.name)).toContain("mark_checklist_item");
    expect(listMcpTools(true).map((tool) => tool.name)).toContain("attribution_checkpoint");
    expect(listMcpTools(false).some((tool) => tool.name === "export_pack" || tool.name === "accept_ticket")).toBe(false);

    const root = await makeTempDir("memolog-security-mcp-");
    await expect(callMcpTool(
      "mark_checklist_item",
      { ticketId: "T-0123456789ab", item: "1" },
      { rootDir: root },
    )).rejects.toThrow(/disabled/);
    await expect(callMcpTool(
      "mark_checklist_item",
      { ticketId: "T-0123456789ab", item: "1" },
      { rootDir: root, allowWrites: false },
    )).rejects.toThrow(/disabled/);
  });

  it("keeps serve loopback-only and MCP HTTP on loopback", () => {
    const cli = fs.readFileSync("src/cli/runCli.ts", "utf8");
    expect(cli).toContain('.command("serve")');
    expect(fs.readFileSync("src/engine/serve.ts", "utf8")).toContain("assertServeHost");
    expect(DEFAULT_MCP_HTTP_HOST).toBe("127.0.0.1");
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  it("still rejects parent-directory traversal", () => {
    const root = path.resolve("/tmp/memo-log-security-root");
    expect(() => assertPathWithinRoot(root, path.join(root, "src", "ok.ts"))).not.toThrow();
    expect(() => assertPathWithinRoot(root, path.join(root, "..", "escape.ts"))).toThrow(SecurityPathError);
  });

  it("does not let session prefs change ticket bytes", async () => {
    const root = await makeTempDir("memolog-security-ticket-");
    await runCli(["init", root]);
    await fs.promises.mkdir(path.join(root, "src"), { recursive: true });
    await fs.promises.writeFile(
      path.join(root, "src", "login.ts"),
      "export function login(email: string) { return email; }\n",
      "utf8",
    );
    await runCli(["scan", root, "--format", "md", "--quiet"]);
    await runCli(["session", "start", "security-test", "-C", root, "--json"]);
    await fs.promises.writeFile(
      path.join(root, "src", "login.ts"),
      "export function login(email: string, password: string) { return email && password; }\n",
      "utf8",
    );
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(["session", "end", "-C", root, "--json"]);
    } finally {
      process.stdout.write = original;
    }
    const ticketId = (JSON.parse(chunks.join("").trim()) as { ticket: { id: string } }).ticket.id;
    const ticketPath = path.join(root, ".memo-log", "tickets", `${ticketId}.json`);
    const before = await fs.promises.readFile(ticketPath);
    saveSessionPrefs(root, { schema: 1, lastMenu: "tickets", filter: "auth" });
    const after = await fs.promises.readFile(ticketPath);
    expect(after.equals(before)).toBe(true);
    expect(loadTicket(root, ticketId)?.id).toBe(ticketId);
  });
});
