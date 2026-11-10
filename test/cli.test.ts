import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function normalizeVolatileTimestamps(content: string): string {
  return content.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<ts>");
}

describe("cli behavior", () => {
  it("init creates config in empty repo", async () => {
    const root = await makeTempDir("memolog-cli-init-");
    const exitCode = await runCli(["init", root]);

    const configPath = path.join(root, ".memolog.json");
    const file = await fs.readFile(configPath, "utf8");

    expect(exitCode).toBe(0);
    expect(file).toContain("\"mode\": \"dual\"");
  });

  it("init is idempotent without --force", async () => {
    const root = await makeTempDir("memolog-cli-idempotent-");
    const configPath = path.join(root, ".memolog.json");

    await runCli(["init", root]);
    await fs.writeFile(configPath, "{\"mode\":\"simple\"}\n", "utf8");
    const exitCode = await runCli(["init", root]);
    const file = await fs.readFile(configPath, "utf8");

    expect(exitCode).toBe(0);
    expect(file).toBe("{\"mode\":\"simple\"}\n");
  });

  it("scan emits deterministic output for unchanged input", async () => {
    const root = await makeTempDir("memolog-cli-scan-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");

    const firstExit = await runCli(["scan", root, "--format", "md"]);
    const firstOutput = await fs.readFile(path.join(root, "MEMO_LOG.md"), "utf8");

    await fs.rm(path.join(root, ".memo-log"), { recursive: true, force: true });
    await fs.rm(path.join(root, "MEMO_LOG.md"), { force: true });
    const secondExit = await runCli(["scan", root, "--format", "md"]);
    const secondOutput = await fs.readFile(path.join(root, "MEMO_LOG.md"), "utf8");

    expect(firstExit).toBe(0);
    expect(secondExit).toBe(0);
    expect(normalizeVolatileTimestamps(secondOutput)).toBe(normalizeVolatileTimestamps(firstOutput));
  });

  it("scan exits non-zero when --out is used with --format both", async () => {
    const root = await makeTempDir("memolog-cli-out-");
    await runCli(["init", root]);
    const exitCode = await runCli([
      "scan",
      root,
      "--format",
      "both",
      "--out",
      "memory.md"
    ]);

    expect(exitCode).not.toBe(0);
  });

  it("scan appends session notes only when --include-agent-notes is enabled", async () => {
    const root = await makeTempDir("memolog-cli-notes-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "feature.ts"), "export function featureFlag() { return true; }\n", "utf8");
    await fs.writeFile(path.join(root, "AGENTS.md"), "# Session\n- Updated feature flag\n", "utf8");

    const exitCode = await runCli([
      "scan",
      root,
      "--mode",
      "dual",
      "--format",
      "md",
      "--include-agent-notes",
    ]);

    const output = await fs.readFile(path.join(root, "MEMO_LOG.md"), "utf8");
    expect(exitCode).toBe(0);
    expect(output).toContain("Session Notes (Unverified Agent Metadata)");
    expect(output).toContain("AGENTS.md");
    expect(output).toContain("Suggested Commits");
    expect(output.indexOf("Suggested Commits")).toBeGreaterThan(output.indexOf("Session Notes (Unverified Agent Metadata)"));
  });

  it("scan tech mode uses deterministic structural pipeline", async () => {
    const root = await makeTempDir("memolog-cli-tech-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "auth.ts"), "export function loginUser() { return true; }\n", "utf8");

    const firstExit = await runCli(["scan", root, "--mode", "tech", "--format", "md"]);
    const firstOutput = await fs.readFile(path.join(root, "MEMO_LOG.md"), "utf8");

    await fs.rm(path.join(root, ".memo-log"), { recursive: true, force: true });
    await fs.rm(path.join(root, "MEMO_LOG.md"), { force: true });
    const secondExit = await runCli(["scan", root, "--mode", "tech", "--format", "md"]);
    const secondOutput = await fs.readFile(path.join(root, "MEMO_LOG.md"), "utf8");

    expect(firstExit).toBe(0);
    expect(secondExit).toBe(0);
    expect(normalizeVolatileTimestamps(firstOutput)).toBe(normalizeVolatileTimestamps(secondOutput));
    expect(firstOutput).toContain("Engineering Ledger (Technical)");
  });

  it("scan respects mode from .memolog.json when --mode is omitted", async () => {
    const root = await makeTempDir("memolog-cli-config-mode-");
    await runCli(["init", root]);
    await fs.writeFile(
      path.join(root, ".memolog.json"),
      JSON.stringify({ mode: "simple" }),
      "utf8",
    );
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "auth.ts"), "export function loginUser() { return true; }\n", "utf8");

    const exit = await runCli(["scan", root, "--format", "md"]);
    const output = await fs.readFile(path.join(root, "MEMO_LOG.md"), "utf8");

    expect(exit).toBe(0);
    expect(output).toContain("Executive Brief (Non-Technical)");
    expect(output).not.toContain("Engineering Ledger (Technical)");
  });

  it("validate accepts a just-scanned MEMO_LOG.json", async () => {
    const root = await makeTempDir("memolog-cli-validate-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "ok.ts"), "export function ping() { return 1; }\n", "utf8");
    await runCli(["scan", root, "--format", "json"]);
    const exit = await runCli(["validate", path.join(root, "MEMO_LOG.json")]);
    expect(exit).toBe(0);
  });

  it("validate rejects garbage json", async () => {
    const root = await makeTempDir("memolog-cli-validate-bad-");
    const bad = path.join(root, "MEMO_LOG.json");
    await fs.writeFile(bad, "{nope", "utf8");
    const exit = await runCli(["validate", bad]);
    expect(exit).not.toBe(0);
  });

  it("scan --help is happy-path only", async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const exit = await runCli(["scan", "--help"]);
      expect(exit).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    const text = chunks.join("");
    expect(text).toContain("--watch");
    expect(text).toContain("--help-advanced");
    expect(text).not.toContain("--infer-runtime");
    expect(text).not.toContain("--max-depth");
    expect(text).not.toContain("--include-agent-notes");
    expect(text).not.toContain("--export-context");
    expect(text).not.toContain("--max-tokens");
  });

  it("scan --help-advanced shows power-user flags", async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const exit = await runCli(["scan", "--help-advanced"]);
      expect(exit).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    const text = chunks.join("");
    expect(text).toContain("--out");
    expect(text).toContain("--filter");
    expect(text).toContain("--export-context");
    expect(text).toContain("--audience");
    expect(text).toContain("--max-tokens");
    expect(text).toContain("--export-context-md");
    expect(text).not.toContain("--infer-runtime");
  });

  it("scan --help-experimental shows runtime flags", async () => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const exit = await runCli(["scan", "--help-experimental"]);
      expect(exit).toBe(0);
    } finally {
      process.stdout.write = orig;
    }
    const text = chunks.join("");
    expect(text).toContain("--infer-runtime");
    expect(text).toContain("--export-context");
  });

  it("rejects engine knobs as CLI flags with a config deprecation message", async () => {
    const root = await makeTempDir("memolog-cli-moved-flag-");
    await runCli(["init", root]);
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((entry) => String(entry)).join(" "));
    };
    let exit = 0;
    try {
      exit = await runCli(["scan", root, "--max-depth", "3"]);
    } finally {
      console.error = originalError;
    }

    const text = errors.join(" ");
    expect(exit).not.toBe(0);
    expect(text).toContain("DEPRECATED FLAG");
    expect(text).toContain(".memolog.json");
  });

  it("rejects export-context modifiers without --export-context", async () => {
    const root = await makeTempDir("memolog-cli-export-modifier-");
    await runCli(["init", root]);

    expect(await runCli(["scan", root, "--max-tokens", "100"])).not.toBe(0);
    expect(await runCli(["scan", root, "--audience", "simple"])).not.toBe(0);
    expect(await runCli(["scan", root, "--export-context-md"])).not.toBe(0);
  });
});
