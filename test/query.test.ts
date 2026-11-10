import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";

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

describe("query command", () => {
  it("returns ranked, reference-anchored entries filtered by category", async () => {
    const root = await makeTempDir("memolog-query-");
    await runCli(["init", root]);
    await writeFile(
      root,
      "src/auth/login.ts",
      "export function login(email: string) { return email; }\nexport class Session {}\n",
    );
    await writeFile(
      root,
      "src/utils/clip.ts",
      "export function clip(value: string) { return value.slice(0, 1); }\n",
    );
    await runCli(["scan", root, "--format", "both", "--quiet"]);

    const capture = captureStdout();
    let exitCode: number;
    try {
      exitCode = await runCli([
        "query",
        root,
        "--category",
        "auth",
        "--limit",
        "5",
        "--json",
      ]);
    } finally {
      capture.restore();
    }

    expect(exitCode).toBe(0);
    const payload = JSON.parse(capture.chunks.join("").trim()) as {
      kind: string;
      filters: { category?: string; limit: number };
      totalCandidates: number;
      entries: Array<{ ref: string; category: string; kind: string; score: number; tech?: string }>;
    };

    expect(payload.kind).toBe("memo-log-query");
    expect(payload.filters.category).toBe("auth");
    expect(payload.filters.limit).toBe(5);
    expect(payload.totalCandidates).toBeGreaterThan(0);
    expect(payload.entries.length).toBeGreaterThan(0);
    expect(payload.entries.length).toBeLessThanOrEqual(5);
    expect(payload.entries.every((entry) => entry.category === "auth")).toBe(true);
    expect(payload.entries.every((entry) => entry.ref.startsWith("[src/auth/login.ts:"))).toBe(true);
    expect(payload.entries.every((entry) => entry.tech !== undefined)).toBe(true);
    expect(payload.entries.every((entry) => entry.score >= 0 && entry.score <= 1)).toBe(true);
  });

  it("filters by export kind", async () => {
    const root = await makeTempDir("memolog-query-kind-");
    await runCli(["init", root]);
    await writeFile(
      root,
      "src/auth/login.ts",
      "export function login(email: string) { return email; }\nexport class Session {}\n",
    );
    await runCli(["scan", root, "--format", "both", "--quiet"]);

    const capture = captureStdout();
    let exitCode: number;
    try {
      exitCode = await runCli(["query", root, "--kind", "class", "--json"]);
    } finally {
      capture.restore();
    }

    expect(exitCode).toBe(0);
    const payload = JSON.parse(capture.chunks.join("").trim()) as {
      entries: Array<{ kind: string }>;
    };
    expect(payload.entries.length).toBeGreaterThan(0);
    expect(payload.entries.every((entry) => entry.kind === "class")).toBe(true);
  });

  it("fails fast when no scan output exists", async () => {
    const root = await makeTempDir("memolog-query-missing-");
    await runCli(["init", root]);
    const exitCode = await runCli(["query", root, "--json"]);
    expect(exitCode).toBe(2);
  });

  it("rejects unknown category and ticket-state filters", async () => {
    const root = await makeTempDir("memolog-query-invalid-");
    await runCli(["init", root]);
    await writeFile(root, "src/auth/login.ts", "export function login(email: string) { return email; }\n");
    await runCli(["scan", root, "--format", "both", "--quiet"]);

    expect(await runCli(["query", root, "--category", "nope", "--json"])).toBe(2);
    expect(await runCli(["tickets", root, "--state", "nope", "--json"])).toBe(2);
    expect(await runCli(["query", root, "--audience", "nope", "--json"])).toBe(2);
  });
});
