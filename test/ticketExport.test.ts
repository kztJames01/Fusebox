import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";
import {
  buildGithubIssue,
  githubTicketMarker,
  writeGithubExport,
  writeMarkdownExport,
} from "../src/engine/ticketExport.js";
import { loadTickets } from "../src/engine/tickets.js";

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

async function createFixture(): Promise<{ root: string; ticketId: string }> {
  const root = await makeTempDir("memolog-export-");
  await runCli(["init", root]);
  await writeFile(root, "src/auth/login.ts", "export function login(email: string) { return email; }\n");
  await runCli(["scan", root, "--format", "both", "--quiet"]);
  await runCli(["session", "start", "export fixture", "-C", root, "--json"]);
  await writeFile(
    root,
    "src/auth/login.ts",
    [
      "export function login(email: string, password: string) { return email && password; }",
      "export function logout() {}",
      "",
    ].join("\n"),
  );
  const capture = captureStdout();
  try {
    await runCli(["session", "end", "-C", root, "--json"]);
  } finally {
    capture.restore();
  }
  const payload = JSON.parse(capture.chunks.join("").trim()) as { ticket: { id: string } };
  return { root, ticketId: payload.ticket.id };
}

describe("ticket export", () => {
  it("builds a deterministic GitHub issue with a marker and reference-anchored checklist", async () => {
    const { root, ticketId } = await createFixture();
    const ticket = loadTickets(root)[0]!;
    const first = buildGithubIssue(ticket);
    const second = buildGithubIssue(ticket);

    expect(second).toEqual(first);
    expect(first.ticketId).toBe(ticketId);
    expect(first.title.startsWith("[memo-log]")).toBe(true);
    expect(first.labels).toContain("memo-log");
    expect(first.labels).toContain("state:open");
    expect(first.labels).toContain("category:auth");
    expect(first.body.startsWith(githubTicketMarker(ticketId))).toBe(true);
    expect(first.body).toContain("## Checklist");
    expect(first.body).toMatch(/\[src\/auth\/login\.ts:\d+/);
  });

  it("writes stable export files and a gh script without running it", async () => {
    const { root, ticketId } = await createFixture();
    const first = writeGithubExport({ rootDir: root });
    const firstIndex = await fs.readFile(first.indexFile, "utf8");
    const firstBody = await fs.readFile(path.join(first.directory, `${ticketId}.md`), "utf8");
    const firstScript = await fs.readFile(first.scriptFile, "utf8");

    const second = writeGithubExport({ rootDir: root });
    expect(second.directory).toBe(first.directory);
    expect(await fs.readFile(second.indexFile, "utf8")).toBe(firstIndex);
    expect(await fs.readFile(path.join(second.directory, `${ticketId}.md`), "utf8")).toBe(firstBody);
    expect(await fs.readFile(second.scriptFile, "utf8")).toBe(firstScript);

    const index = JSON.parse(firstIndex) as {
      kind: string;
      count: number;
      issues: Array<{ ticketId: string; bodyFile: string }>;
    };
    expect(index.kind).toBe("memo-log-github-export");
    expect(index.count).toBe(1);
    expect(index.issues[0]?.ticketId).toBe(ticketId);
    expect(index.issues[0]?.bodyFile).toBe(`${ticketId}.md`);
    expect(firstScript).toContain("gh issue create");
    expect(firstScript).toContain(githubTicketMarker(ticketId));
    expect(firstScript.startsWith("#!/usr/bin/env bash")).toBe(true);
    // `--body-file` is relative; the script must run from its own directory.
    expect(firstScript).toContain('cd -- "$(dirname -- "$0")"');
  });

  it("exports filtered tickets to markdown and via the CLI", async () => {
    const { root, ticketId } = await createFixture();
    const target = await writeMarkdownExport({ rootDir: root });
    const content = await fs.readFile(target, "utf8");
    expect(content).toContain("# Ticket export");
    expect(content).toContain(ticketId);
    expect(content).toContain(githubTicketMarker(ticketId));

    const capture = captureStdout();
    let exit: number;
    try {
      exit = await runCli(["export", "github", root, "--json"]);
    } finally {
      capture.restore();
    }
    expect(exit).toBe(0);
    const payload = JSON.parse(capture.chunks.join("").trim()) as {
      kind: string;
      directory: string;
      issues: Array<{ ticketId: string }>;
    };
    expect(payload.kind).toBe("memo-log-github-export");
    expect(payload.issues.map((issue) => issue.ticketId)).toContain(ticketId);

    expect(await runCli(["export", "nope", root])).toBe(2);
  });
});
