import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { detectConflicts } from "../src/engine/conflicts.js";
import { runAgentUiWorkflow } from "../src/engine/agentUi.js";

function writeState(rootDir: string, files: Record<string, { hash: string; fingerprint: string; changedAt: number }>): void {
  const stateDir = path.join(rootDir, ".memo-log");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    JSON.stringify({ version: 2, lastRun: new Date().toISOString(), files }, null, 2),
    "utf8",
  );
}

describe("hardening stress", () => {
  it("detectConflicts handles many exports deterministically", () => {
    const agentA = Array.from({ length: 80 }, (_, i) => ({
      path: `src/f${i}.ts`,
      lang: "ts" as const,
      contentHash: "a",
      imports: [],
      usedFallback: false,
      warnings: [],
      exports: [{ name: "run", kind: "function" as const, line: 1, column: 0 }],
      signatures: [{ name: "run", signature: `function run(v${i})`, line: 1, column: 0, async: false, generator: false, params: [`v${i}`] }],
    }));
    const agentB = Array.from({ length: 80 }, (_, i) => ({
      path: `src/f${i}.ts`,
      lang: "ts" as const,
      contentHash: "b",
      imports: [],
      usedFallback: false,
      warnings: [],
      exports: [{ name: "run", kind: "function" as const, line: 1, column: 0 }],
      signatures: [{ name: "run", signature: `function run(x${i}, y${i})`, line: 1, column: 0, async: false, generator: false, params: [`x${i}`, `y${i}`] }],
    }));

    const r1 = detectConflicts(agentA, agentB, { scannedAt: "2026-01-01T00:00:00.000Z" });
    const r2 = detectConflicts(agentA, agentB, { scannedAt: "2030-01-01T00:00:00.000Z" });
    expect(r1.hash).toBe(r2.hash);
    expect(r1.totalConflicts).toBe(80);
  });

  it("agent-ui workflow surfaces cap warning under heavy state", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-log-hardening-cap-"));
    const files: Record<string, { hash: string; fingerprint: string; changedAt: number }> = {};
    for (let i = 0; i < 105; i++) {
      const rel = `src/heavy-${i}.ts`;
      const abs = path.join(rootDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `export const v${i} = ${i};\n`, "utf8");
      files[rel] = { hash: `h${i}`, fingerprint: `f${i}`, changedAt: Date.now() + i };
    }
    writeState(rootDir, files);
    const result = await runAgentUiWorkflow(rootDir);
    expect(result.warnings.some((w) => w.includes("AGENT_UI_FILE_CAP_APPLIED"))).toBe(true);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("inference path collector rejects traversal refs", async () => {
    const { assertPathWithinRoot, normalizeRelativePath, resolveSecureRoot } = await import("../src/security/pathGuards.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memo-log-hardening-traversal-"));
    const secureRoot = await resolveSecureRoot(root);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "safe.ts"), "export const safe = 1;\n", "utf8");

    const refs = ["src/safe.ts", "../outside.ts"];
    const accepted: string[] = [];
    for (const raw of refs) {
      const rel = normalizeRelativePath(raw);
      if (!rel || rel.includes("..")) continue;
      const abs = path.resolve(secureRoot, rel);
      try {
        assertPathWithinRoot(secureRoot, abs);
        accepted.push(rel);
      } catch {
        // rejected
      }
    }
    expect(accepted).toEqual(["src/safe.ts"]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
