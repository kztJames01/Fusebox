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

interface StructuralPayload {
  ordering: string;
  sources: {
    structural: boolean;
    target?: string;
    targetEntries: number;
    changed: number;
    sameCategory: number;
    dependents: number;
    dependencies: number;
  };
  totalCandidates: number;
  entries: Array<{ ref: string; category: string; score: number }>;
}

async function createFixture(): Promise<string> {
  const root = await makeTempDir("memolog-query-structural-");
  await runCli(["init", root]);
  await writeFile(
    root,
    "src/auth/login.ts",
    "export function login(email: string) { return email; }\n",
  );
  await writeFile(
    root,
    "src/auth/session.ts",
    "export class Session {}\n",
  );
  await writeFile(
    root,
    "src/api/routes.ts",
    [
      "import { login } from \"../auth/login\";",
      "export function route(email: string) { return login(email); }",
      "",
    ].join("\n"),
  );
  await writeFile(
    root,
    "src/utils/clip.ts",
    "export function clip(value: string) { return value.slice(0, 1); }\n",
  );
  await runCli(["scan", root, "--format", "both", "--quiet"]);

  // Produce a real structural diff against the saved baseline state.
  await writeFile(
    root,
    "src/auth/login.ts",
    "export function login(email: string, password: string) { return email && password; }\n",
  );
  await runCli(["scan", root, "--format", "both", "--quiet"]);
  return root;
}

async function query(
  root: string,
  args: string[],
): Promise<StructuralPayload> {
  const capture = captureStdout();
  let exitCode: number;
  try {
    exitCode = await runCli(["query", root, ...args, "--json"]);
  } finally {
    capture.restore();
  }
  expect(exitCode).toBe(0);
  return JSON.parse(capture.chunks.join("").trim()) as StructuralPayload;
}

describe("structural query retrieval", () => {
  it("merges changed files, category matches, and dependents", async () => {
    const root = await createFixture();
    const payload = await query(root, [
      "--structural",
      "--file",
      "src/auth/login.ts",
      "--limit",
      "20",
    ]);

    expect(payload.ordering).toBe("long-context-reorder");
    expect(payload.sources.structural).toBe(true);
    expect(payload.sources.target).toBe("src/auth/login.ts");
    expect(payload.sources.targetEntries).toBeGreaterThan(0);
    expect(payload.sources.changed).toBeGreaterThan(0);
    expect(payload.sources.dependents).toBeGreaterThan(0);

    const files = payload.entries.map((entry) => entry.ref.replace(/^\[(.*?):\d+(?::\d+)?\]$/, "$1"));
    expect(files).toContain("src/auth/login.ts");
    expect(files).toContain("src/api/routes.ts");
    // Unrelated files are excluded by the structural merge.
    expect(files).not.toContain("src/utils/clip.ts");
    expect(payload.totalCandidates).toBeGreaterThanOrEqual(payload.entries.length);
  });

  it("reorders the final slice so the best fact is first", async () => {
    const root = await createFixture();
    const payload = await query(root, [
      "--structural",
      "--file",
      "src/auth/login.ts",
      "--limit",
      "20",
    ]);

    const scores = payload.entries.map((entry) => entry.score);
    expect(scores[0]).toBe(Math.max(...scores));
  });

  it("falls back to the ranked list when no structural signal exists", async () => {
    const root = await makeTempDir("memolog-query-structural-empty-");
    await runCli(["init", root]);
    await writeFile(root, "src/utils/clip.ts", "export function clip(value: string) { return value.slice(0, 1); }\n");
    await runCli(["scan", root, "--format", "both", "--quiet"]);

    const payload = await query(root, ["--structural"]);
    expect(payload.sources.structural).toBe(true);
    expect(payload.totalCandidates).toBeGreaterThan(0);
    expect(payload.entries.length).toBeGreaterThan(0);
  });

  it("rejects traversal targets", async () => {
    const root = await createFixture();
    const capture = captureStdout();
    let exitCode: number;
    try {
      exitCode = await runCli([
        "query",
        root,
        "--structural",
        "--file",
        "../secrets.env",
        "--json",
      ]);
    } finally {
      capture.restore();
    }
    expect(exitCode).toBe(2);
  });
});
