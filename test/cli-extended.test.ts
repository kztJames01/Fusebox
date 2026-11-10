import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";
import { ExportContextSchema } from "../src/cli/exportContext.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("cli integration", () => {
  it("scan --infer-runtime writes inference markdown from real scan outputs", async () => {
    const root = await makeTempDir("memolog-cli-infer-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "routes.ts"),
      [
        "export function getUsers(req, res) { return listUsers(req); }",
        "export function listUsers(req) { return req.users; }",
        "app.get('/users', getUsers);",
      ].join("\n"),
      "utf8",
    );

    const exitCode = await runCli(["scan", root, "--infer-runtime", "--format", "both"]);
    const inferenceMd = await fs.readFile(path.join(root, "MEMO_LOG_INFERENCE.md"), "utf8");

    expect(exitCode).toBe(0);
    expect(inferenceMd).toContain("Runtime Behavior Inference");
    expect(inferenceMd).toContain("API Endpoints");
  });

  it("scan --agent-ui detects conflict against previous snapshot on second run", async () => {
    const root = await makeTempDir("memolog-cli-agent-ui-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    const target = path.join(root, "src", "auth.ts");

    await fs.writeFile(target, "export function loginUser(username, password) { return username + password; }\n", "utf8");

    const firstExit = await runCli(["scan", root, "--agent-ui", "--format", "md"]);
    expect(firstExit).toBe(0);
    await fs.access(path.join(root, ".memo-log", "agent-ui.snapshot.json"));

    await fs.writeFile(target, "export function loginUser(credentials) { return credentials.username + credentials.password; }\n", "utf8");
    const secondExit = await runCli(["scan", root, "--agent-ui", "--format", "md"]);
    const conflictMd = await fs.readFile(path.join(root, "MEMO_LOG_CONFLICTS.md"), "utf8");

    expect(secondExit).toBe(0);
    expect(conflictMd).toContain("CONFLICT");
    expect(conflictMd).toContain("loginUser");
  });

  it("scan --infer-runtime warns when inference file cap is applied", async () => {
    const root = await makeTempDir("memolog-cli-infer-cap-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    for (let i = 0; i < 51; i++) {
      await fs.writeFile(
        path.join(root, "src", `f${i}.ts`),
        `export function fn${i}(req) { return req?.value ?? ${i}; }\n`,
        "utf8",
      );
    }

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((entry) => String(entry)).join(" "));
    };
    try {
      const exitCode = await runCli(["scan", root, "--infer-runtime", "--format", "both"]);
      expect(exitCode).toBe(0);
      expect(warnings.some((line) => line.includes("INFERENCE_FILE_CAP_APPLIED"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("scan --export-context writes stripped MEMO_LOG_CONTEXT.json", async () => {
    const root = await makeTempDir("memolog-cli-export-ctx-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "util.ts"), "export function clip(s: string) { return s.slice(0, 1); }\n", "utf8");
    const exit = await runCli(["scan", root, "--export-context", "--format", "both"]);
    const raw = await fs.readFile(path.join(root, "MEMO_LOG_CONTEXT.json"), "utf8");
    const parsed = JSON.parse(raw) as { kind: string; entries: Array<{ ref: string; tech: string }> };
    expect(exit).toBe(0);
    expect(parsed.kind).toBe("memo-log-export-context");
    expect(parsed.entries.some((e) => e.tech.includes("clip") || e.ref.includes("util.ts"))).toBe(true);
    expect(raw).not.toContain("generatedAt");
  });

  it("scan --export-context uses the scan snapshot when JSON is not written", async () => {
    const root = await makeTempDir("memolog-cli-export-stale-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "MEMO_LOG.json"),
      JSON.stringify({
        entries: [{ ref: "[stale.ts:1:0]", tech: "Function/Method: `staleFn`", simple: "stale", category: "utils" }],
      }),
      "utf8",
    );
    await fs.writeFile(path.join(root, "src", "util.ts"), "export function clip(s: string) { return s.slice(0, 1); }\n", "utf8");

    const exit = await runCli(["scan", root, "--export-context", "--format", "md"]);
    const raw = await fs.readFile(path.join(root, "MEMO_LOG_CONTEXT.json"), "utf8");

    expect(exit).toBe(0);
    expect(raw).toContain("clip");
    expect(raw).not.toContain("staleFn");
    expect(raw).not.toContain("stale.ts");
  });

  it("scan --export-context ranks entries, honors --max-tokens, and writes markdown", async () => {
    const root = await makeTempDir("memolog-cli-export-ranked-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
    await fs.mkdir(path.join(root, "src", "utils"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "auth", "login.ts"),
      "export function loginUser(name: string) { return name; }\n",
      "utf8",
    );
    for (let i = 0; i < 20; i++) {
      await fs.writeFile(
        path.join(root, "src", "utils", `f${i}.ts`),
        `export function util${i}() { return ${i}; }\n`,
        "utf8",
      );
    }

    const exit = await runCli([
      "scan",
      root,
      "--export-context",
      "--export-context-md",
      "--audience",
      "simple",
      "--max-tokens",
      "400",
      "--format",
      "md",
      "--quiet",
    ]);

    const raw = await fs.readFile(path.join(root, "MEMO_LOG_CONTEXT.json"), "utf8");
    const parsed = ExportContextSchema.parse(JSON.parse(raw));
    const markdown = await fs.readFile(path.join(root, "MEMO_LOG_CONTEXT.md"), "utf8");

    expect(exit).toBe(0);
    expect(parsed.audience).toBe("simple");
    expect(parsed.entries[0]?.ref).toContain("src/auth/login.ts");
    expect(parsed.entries.every((entry) => entry.simple !== undefined)).toBe(true);
    expect(parsed.budget.maxTokens).toBe(400);
    expect(parsed.budget.truncated).toBe(true);
    expect(parsed.budget.estimatedTokens).toBeLessThanOrEqual(400);
    expect(markdown).toContain("Verified facts only");
    expect(markdown).toContain("src/auth/login.ts");
  });

  it("scan --export-context is deterministic when state is reset", async () => {
    const root = await makeTempDir("memolog-cli-export-deterministic-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "util.ts"), "export function clip(s: string) { return s.slice(0, 1); }\n", "utf8");

    await runCli(["scan", root, "--export-context", "--format", "md", "--quiet"]);
    const first = await fs.readFile(path.join(root, "MEMO_LOG_CONTEXT.json"), "utf8");

    await fs.rm(path.join(root, ".memo-log"), { recursive: true, force: true });
    await fs.rm(path.join(root, "MEMO_LOG.md"), { force: true });
    await fs.rm(path.join(root, "MEMO_LOG_CONTEXT.json"), { force: true });

    await runCli(["scan", root, "--export-context", "--format", "md", "--quiet"]);
    const second = await fs.readFile(path.join(root, "MEMO_LOG_CONTEXT.json"), "utf8");

    expect(second).toBe(first);
  });

  it("scan --infer-runtime uses the scan snapshot when JSON is not written", async () => {
    const root = await makeTempDir("memolog-cli-infer-stale-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "MEMO_LOG.json"),
      JSON.stringify({
        entries: [{ ref: "[missing.ts:1:0]", tech: "Function/Method: `missingFn`" }],
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "src", "routes.ts"),
      [
        "export function getUsers(req, res) { return listUsers(req); }",
        "export function listUsers(req) { return req.users; }",
        "app.get('/users', getUsers);",
      ].join("\n"),
      "utf8",
    );

    const exitCode = await runCli(["scan", root, "--infer-runtime", "--format", "md"]);
    const inferenceMd = await fs.readFile(path.join(root, "MEMO_LOG_INFERENCE.md"), "utf8");

    expect(exitCode).toBe(0);
    expect(inferenceMd).toContain("API Endpoints");
    expect(inferenceMd).toContain("/users");
  });
});
