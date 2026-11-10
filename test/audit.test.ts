// Tests for the audit export command
import { describe, it, expect } from "vitest";
import { parseConflictReportEvents, runAuditCommand } from "../src/cli/audit.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function setupTmpProject(): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memo-log-audit-test-"));
  const stateDir = path.join(tmpDir, ".memo-log");
  fs.mkdirSync(stateDir, { recursive: true });

  // Write canonical StateV2 shape from engine/diff.ts
  const state = {
    version: 2,
    lastRun: "2026-01-01T00:00:00.000Z",
    files: {
      "src/auth.ts": {
        hash: "hash-auth",
        fingerprint: "fp-auth",
        changedAt: 1700000000000,
      },
      "src/api.ts": {
        hash: "hash-api",
        fingerprint: "fp-api",
        changedAt: 1700000000100,
      },
    },
  };
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state, null, 2), "utf8");

  // Write canonical HistoryLogV1 shape from engine/diff.ts
  const history = {
    version: 1,
    events: [
      {
        id: "event-1",
        generatedAt: "2025-12-01T00:00:00.000Z",
        summary: "+1 ~1",
        changes: [
          { path: "src/auth.ts", changeType: "ADDED", category: "auth" },
          { path: "src/api.ts", changeType: "MODIFIED", category: "api" },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(stateDir, "history.json"), JSON.stringify(history, null, 2), "utf8");
  fs.writeFileSync(
    path.join(tmpDir, "MEMO_LOG_CONFLICTS.md"),
    [
      "## Multi-Agent Conflict Report",
      "Generated: 2026-01-01T00:00:00.000Z",
      "### [HIGH] loginUser in src/auth.ts",
      "CONFLICT: export \"loginUser\" has different signatures.",
    ].join("\n"),
    "utf8",
  );
  return tmpDir;
}

describe("runAuditCommand", () => {
  it("outputs valid JSON to stdout when no --out provided", async () => {
    const tmpDir = setupTmpProject();
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await runAuditCommand({ targetDir: tmpDir, format: "json" });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = chunks.join("");
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed["schemaVersion"]).toBe(1);
    expect(typeof parsed["hash"]).toBe("string");
    expect((parsed["hash"] as string).length).toBe(64);
    expect(Array.isArray(parsed["events"])).toBe(true);
    expect((parsed["events"] as unknown[]).length).toBeGreaterThan(0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes audit JSON to file atomically when --out is specified", async () => {
    const tmpDir = setupTmpProject();
    const outPath = path.join(tmpDir, "audit_out.json");

    await runAuditCommand({ targetDir: tmpDir, format: "json", out: outPath });

    expect(fs.existsSync(outPath)).toBe(true);
    const content = fs.readFileSync(outPath, "utf8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed["schemaVersion"]).toBe(1);
    expect(parsed["totalFiles"]).toBe(2);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("produces text output when format=text", async () => {
    const tmpDir = setupTmpProject();
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;

    try {
      await runAuditCommand({ targetDir: tmpDir, format: "text" });
    } finally {
      process.stdout.write = origWrite;
    }

    const output = chunks.join("");
    expect(output).toContain("memo-log Audit Trail");
    expect(output).toContain("Zero LLM calls");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hash is deterministic across two reads of the same state", async () => {
    const tmpDir = setupTmpProject();
    const out1 = path.join(tmpDir, "audit1.json");
    const out2 = path.join(tmpDir, "audit2.json");

    await runAuditCommand({ targetDir: tmpDir, format: "json", out: out1 });
    await runAuditCommand({ targetDir: tmpDir, format: "json", out: out2 });

    const a1 = JSON.parse(fs.readFileSync(out1, "utf8")) as Record<string, unknown>;
    const a2 = JSON.parse(fs.readFileSync(out2, "utf8")) as Record<string, unknown>;

    // Semantic payload and hash must stay deterministic; exportedAt may differ.
    expect(a1["schemaVersion"]).toBe(a2["schemaVersion"]);
    expect(JSON.stringify(a1["events"])).toBe(JSON.stringify(a2["events"]));
    expect(a1["hash"]).toBe(a2["hash"]);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes explicit change events from history log", async () => {
    const tmpDir = setupTmpProject();
    const outPath = path.join(tmpDir, "audit-changes.json");
    await runAuditCommand({ targetDir: tmpDir, format: "json", out: outPath });

    const parsed = JSON.parse(fs.readFileSync(outPath, "utf8")) as {
      events: Array<{ type: string; filePath?: string; details?: Record<string, unknown> }>;
    };
    const changeEvents = parsed.events.filter((event) => event.type === "change");
    expect(changeEvents.length).toBeGreaterThan(0);
    expect(changeEvents.some((event) => event.filePath === "src/auth.ts")).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parseConflictReportEvents ignores malformed headings", () => {
    const md = [
      "## Multi-Agent Conflict Report",
      "Generated: 2026-01-01T00:00:00.000Z",
      "### [HIGH]  in ",
      "### [HIGH] bad in ../escape.ts",
      "### [HIGH] loginUser in src/auth.ts",
    ].join("\n");
    const events = parseConflictReportEvents(md);
    expect(events).toHaveLength(1);
    expect(events[0]?.filePath).toBe("src/auth.ts");
    expect(events[0]?.details?.exportName).toBe("loginUser");
    expect(events[0]?.timestamp).toBe("2026-01-01T00:00:00.000Z");
  });

  it("conflict audit events are deterministic for identical report content", async () => {
    const tmpDir = setupTmpProject();
    const out1 = path.join(tmpDir, "audit-conflict-determinism-1.json");
    const out2 = path.join(tmpDir, "audit-conflict-determinism-2.json");
    await runAuditCommand({ targetDir: tmpDir, format: "json", out: out1 });
    await runAuditCommand({ targetDir: tmpDir, format: "json", out: out2 });
    const a1 = JSON.parse(fs.readFileSync(out1, "utf8")) as { hash: string; events: unknown[] };
    const a2 = JSON.parse(fs.readFileSync(out2, "utf8")) as { hash: string; events: unknown[] };
    expect(a1.hash).toBe(a2.hash);
    expect(JSON.stringify(a1.events)).toBe(JSON.stringify(a2.events));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes conflict events when MEMO_LOG_CONFLICTS.md exists", async () => {
    const tmpDir = setupTmpProject();
    const outPath = path.join(tmpDir, "audit-conflicts.json");
    await runAuditCommand({ targetDir: tmpDir, format: "json", out: outPath });
    const parsed = JSON.parse(fs.readFileSync(outPath, "utf8")) as {
      events: Array<{ type: string; filePath?: string; details?: Record<string, unknown> }>;
    };
    const conflictEvents = parsed.events.filter((event) => event.type === "conflict");
    expect(conflictEvents.length).toBeGreaterThan(0);
    expect(conflictEvents.some((event) => event.filePath === "src/auth.ts")).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
