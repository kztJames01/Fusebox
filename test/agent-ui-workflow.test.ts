import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildCurrentParsedFilesFromState,
  runAgentUiWorkflow,
} from "../src/engine/agentUi.js";

function writeState(rootDir: string, relativePath: string): void {
  const stateDir = path.join(rootDir, ".memo-log");
  fs.mkdirSync(stateDir, { recursive: true });
  const state = {
    version: 2,
    lastRun: new Date().toISOString(),
    files: {
      [relativePath]: {
        hash: "fake-hash",
        fingerprint: "fake-fp",
        changedAt: Date.now(),
      },
    },
  };
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}

describe("agent-ui workflow", () => {
  it("parses files from StateV2 record shape", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-log-agent-ui-state-"));
    const fileRel = "src/auth.ts";
    const fileAbs = path.join(rootDir, fileRel);
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    fs.writeFileSync(fileAbs, "export function loginUser(name: string) { return name; }\n", "utf8");
    writeState(rootDir, fileRel);

    const parsed = await buildCurrentParsedFilesFromState(rootDir);
    expect(parsed.stateAvailable).toBe(true);
    expect(parsed.totalStateFiles).toBe(1);
    expect(parsed.parsedFiles.length).toBe(1);
    expect(parsed.parsedFiles[0]?.path).toBe(fileRel);
    expect(parsed.parsedFiles[0]?.exports.some((entry) => entry.name === "loginUser")).toBe(true);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("compares previous snapshot vs current scan to detect conflicts", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-log-agent-ui-conflict-"));
    const fileRel = "src/auth.ts";
    const fileAbs = path.join(rootDir, fileRel);
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    writeState(rootDir, fileRel);

    // Baseline snapshot
    fs.writeFileSync(
      fileAbs,
      "export function loginUser(username: string, password: string) { return username + password; }\n",
      "utf8",
    );
    const first = await runAgentUiWorkflow(rootDir);
    expect(first.previousSnapshotFound).toBe(false);
    expect(first.report).toBeNull();

    // Current snapshot with conflicting signature
    fs.writeFileSync(
      fileAbs,
      "export function loginUser(credentials: { u: string; p: string }) { return credentials.u + credentials.p; }\n",
      "utf8",
    );
    const second = await runAgentUiWorkflow(rootDir);
    expect(second.previousSnapshotFound).toBe(true);
    expect(second.report).not.toBeNull();
    expect(second.report?.totalConflicts).toBeGreaterThan(0);
    expect(second.report?.conflicts.some((entry) => entry.exportName === "loginUser")).toBe(true);

    const reportMd = fs.readFileSync(second.reportPath, "utf8");
    expect(reportMd).toContain("CONFLICT");
    expect(reportMd).toContain("loginUser");

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("does not overwrite existing snapshot when state is empty", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-log-agent-ui-preserve-"));
    const fileRel = "src/auth.ts";
    const fileAbs = path.join(rootDir, fileRel);
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    writeState(rootDir, fileRel);
    fs.writeFileSync(
      fileAbs,
      "export function loginUser(username: string, password: string) { return username + password; }\n",
      "utf8",
    );
    await runAgentUiWorkflow(rootDir);
    const snapshotPath = path.join(rootDir, ".memo-log", "agent-ui.snapshot.json");
    const before = fs.readFileSync(snapshotPath, "utf8");

    // State becomes empty: should preserve previous snapshot instead of clobbering.
    const emptyState = {
      version: 2,
      lastRun: new Date().toISOString(),
      files: {},
    };
    fs.writeFileSync(path.join(rootDir, ".memo-log", "state.json"), JSON.stringify(emptyState, null, 2), "utf8");
    const second = await runAgentUiWorkflow(rootDir);
    const after = fs.readFileSync(snapshotPath, "utf8");

    expect(second.warnings.some((w) => w.includes("AGENT_UI_STATE_EMPTY"))).toBe(true);
    expect(second.warnings.some((w) => w.includes("AGENT_UI_SNAPSHOT_PRESERVED"))).toBe(true);
    expect(second.warnings.some((w) => w.includes("AGENT_UI_CONFLICT_SKIPPED_EMPTY_CURRENT"))).toBe(true);
    expect(after).toBe(before);
    expect(fs.readFileSync(second.reportPath, "utf8")).toContain("Conflict detection skipped");

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("skips unsafe traversal paths from state.json", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-log-agent-ui-traversal-"));
    const stateDir = path.join(rootDir, ".memo-log");
    fs.mkdirSync(stateDir, { recursive: true });
    const safeRel = "src/safe.ts";
    const safeAbs = path.join(rootDir, safeRel);
    fs.mkdirSync(path.dirname(safeAbs), { recursive: true });
    fs.writeFileSync(safeAbs, "export const safe = true;\n", "utf8");
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify(
        {
          version: 2,
          lastRun: new Date().toISOString(),
          files: {
            [safeRel]: { hash: "h1", fingerprint: "f1", changedAt: Date.now() },
            "../outside.ts": { hash: "h2", fingerprint: "f2", changedAt: Date.now() + 1 },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const parsed = await buildCurrentParsedFilesFromState(rootDir);
    expect(parsed.parsedFiles.some((f) => f.path === safeRel)).toBe(true);
    expect(parsed.parsedFiles.some((f) => f.path.includes("outside"))).toBe(false);
    expect(parsed.warnings.some((w) => w.includes("AGENT_UI_UNSAFE_STATE_PATH_SKIPPED"))).toBe(true);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("filters previous snapshot to capped path set before compare", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-log-agent-ui-cap-filter-"));
    const stateDir = path.join(rootDir, ".memo-log");
    fs.mkdirSync(stateDir, { recursive: true });

    const baselineRel = "src/zz-only-in-old-snapshot.ts";
    const baselineAbs = path.join(rootDir, baselineRel);
    fs.mkdirSync(path.dirname(baselineAbs), { recursive: true });
    fs.writeFileSync(baselineAbs, "export function oldOnly() { return 1; }\n", "utf8");
    writeState(rootDir, baselineRel);
    await runAgentUiWorkflow(rootDir);

    const files: Record<string, { hash: string; fingerprint: string; changedAt: number }> = {};
    for (let i = 0; i < 101; i++) {
      const rel = `src/cap-${String(i).padStart(3, "0")}.ts`;
      const abs = path.join(rootDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `export const v${i} = ${i};\n`, "utf8");
      files[rel] = { hash: `h${i}`, fingerprint: `f${i}`, changedAt: Date.now() + i };
    }
    // Keep old snapshot file present on disk but exclude it from capped state entries.
    fs.writeFileSync(baselineAbs, "export function oldOnly() { return 2; }\n", "utf8");
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify({ version: 2, lastRun: new Date().toISOString(), files }, null, 2),
      "utf8",
    );

    const result = await runAgentUiWorkflow(rootDir);
    // If previous snapshot wasn't filtered to capped set, this would include one-sided conflict.
    expect(result.report?.conflicts.some((c) => c.exportName === "oldOnly")).toBe(false);
    expect(result.warnings.some((w) => w.includes("AGENT_UI_FILE_CAP_APPLIED"))).toBe(true);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("emits cap warning when state file count exceeds 100", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-log-agent-ui-cap-"));
    const stateDir = path.join(rootDir, ".memo-log");
    fs.mkdirSync(stateDir, { recursive: true });
    const files: Record<string, { hash: string; fingerprint: string; changedAt: number }> = {};
    for (let i = 0; i < 101; i++) {
      const rel = `src/file${i}.ts`;
      files[rel] = { hash: `h${i}`, fingerprint: `f${i}`, changedAt: Date.now() + i };
      const abs = path.join(rootDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `export const v${i} = ${i};\n`, "utf8");
    }
    fs.writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify({ version: 2, lastRun: new Date().toISOString(), files }, null, 2),
      "utf8",
    );

    const result = await runAgentUiWorkflow(rootDir);
    expect(result.warnings.some((w) => w.includes("AGENT_UI_FILE_CAP_APPLIED"))).toBe(true);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("falls back cleanly when snapshot file is corrupted JSON", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-log-agent-ui-corrupt-"));
    const stateDir = path.join(rootDir, ".memo-log");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "agent-ui.snapshot.json"), "{not-json", "utf8");

    const fileRel = "src/auth.ts";
    const fileAbs = path.join(rootDir, fileRel);
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    fs.writeFileSync(fileAbs, "export function loginUser(name: string) { return name; }\n", "utf8");
    writeState(rootDir, fileRel);

    const result = await runAgentUiWorkflow(rootDir);
    expect(result.previousSnapshotFound).toBe(false);
    expect(result.report).toBeNull();
    const snapshotAfter = fs.readFileSync(path.join(stateDir, "agent-ui.snapshot.json"), "utf8");
    expect(() => JSON.parse(snapshotAfter)).not.toThrow();

    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it("leaves no temporary snapshot files after atomic writes", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-log-agent-ui-tmp-"));
    const fileRel = "src/a.ts";
    const fileAbs = path.join(rootDir, fileRel);
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    fs.writeFileSync(fileAbs, "export const a = 1;\n", "utf8");
    writeState(rootDir, fileRel);

    await runAgentUiWorkflow(rootDir);

    const stateDir = path.join(rootDir, ".memo-log");
    const leakedTemps = fs.readdirSync(stateDir).filter((name) => name.startsWith(".tmp-"));
    expect(leakedTemps).toEqual([]);

    fs.rmSync(rootDir, { recursive: true, force: true });
  });
});
