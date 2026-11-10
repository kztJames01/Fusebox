// audit command: deterministic, Zod-validated JSON export of memo-log state
// memo-log audit [targetDir] --format json
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { CACHE_DIR } from "../engine/cache.js";
import { loadHistory, loadState } from "../engine/diff.js";

const AUDIT_SCHEMA_VERSION = 1;

const AuditEventSchema = z.object({
  type: z.enum(["scan", "change", "conflict"]),
  timestamp: z.string().datetime(),
  filePath: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const AuditExportSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.string().datetime(),
  targetDir: z.string(),
  events: z.array(AuditEventSchema),
  totalFiles: z.number().int().nonnegative(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditExport = z.infer<typeof AuditExportSchema>;

export interface AuditOptions {
  targetDir: string;
  format: "json" | "text";
  out?: string | undefined;
}

export async function runAuditCommand(options: AuditOptions): Promise<void> {
  const absoluteTarget = path.resolve(options.targetDir);

  // Read state files from .memo-log/
  const stateDir = path.join(absoluteTarget, CACHE_DIR);
  const events = await collectAuditEvents(stateDir, absoluteTarget);

  // Build deterministic export
  const exportData = buildAuditExport(absoluteTarget, events);

  // Validate with Zod before output
  const validated = AuditExportSchema.parse(exportData);

  if (options.format === "json") {
    const output = JSON.stringify(validated, null, 2);
    if (options.out) {
      await atomicWriteFile(options.out, output);
      console.log(`Audit written to: ${options.out}`);
    } else {
      process.stdout.write(output + "\n");
    }
  } else {
    const text = renderAuditText(validated);
    if (options.out) {
      await atomicWriteFile(options.out, text);
      console.log(`Audit written to: ${options.out}`);
    } else {
      process.stdout.write(text + "\n");
    }
  }
}

const CONFLICT_HEADER_PATTERN = /^### \[(HIGH|MEDIUM|INFO)\] ([^\n]+?) in ([^\n]+)$/gm;

function isValidIsoTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

// Deterministic conflict events: timestamp comes from report body, not file mtime.
export function parseConflictReportEvents(content: string): AuditEvent[] {
  const events: AuditEvent[] = [];
  const generatedMatch = /^Generated:\s*(.+)$/m.exec(content);
  const generatedTs = generatedMatch?.[1]?.trim() ?? "";
  const timestamp = generatedTs && isValidIsoTimestamp(generatedTs)
    ? generatedTs
    : "1970-01-01T00:00:00.000Z";

  let conflictCount = 0;
  let conflictMatch: RegExpExecArray | null;
  CONFLICT_HEADER_PATTERN.lastIndex = 0;
  while ((conflictMatch = CONFLICT_HEADER_PATTERN.exec(content)) !== null) {
    const severity = conflictMatch[1]?.trim() ?? "";
    const exportName = conflictMatch[2]?.trim() ?? "";
    const filePath = conflictMatch[3]?.trim() ?? "";
    if (!severity || !exportName || !filePath || filePath.includes("..")) {
      continue;
    }
    conflictCount += 1;
    events.push({
      type: "conflict",
      timestamp,
      filePath,
      details: { severity, exportName },
    });
  }

  if (conflictCount === 0 && content.includes("Conflict detection skipped")) {
    events.push({
      type: "conflict",
      timestamp,
      details: {
        status: "skipped",
        source: "MEMO_LOG_CONFLICTS.md",
      },
    });
  }

  return events;
}

async function collectAuditEvents(stateDir: string, targetDir: string): Promise<AuditEvent[]> {
  const events: AuditEvent[] = [];

  // Read history in canonical format from engine/diff.ts
  const history = loadHistory(targetDir);
  for (const event of history.events) {
    events.push({
      type: "scan",
      timestamp: event.generatedAt,
      details: {
        summary: event.summary,
        historyEventId: event.id,
        changedEntries: event.changes.length,
      },
    });
    for (const change of event.changes) {
      events.push({
        type: "change",
        timestamp: event.generatedAt,
        filePath: change.path,
        details: {
          changeType: change.changeType,
          category: change.category,
          historyEventId: event.id,
        },
      });
    }
  }

  // Read current state snapshot summary in canonical StateV2 format
  const state = loadState(targetDir);
  if (state) {
    events.push({
      type: "scan",
      timestamp: state.lastRun,
      details: {
        version: state.version,
        totalFiles: Object.keys(state.files).length,
        source: path.join(stateDir, "state.json"),
      },
    });
  }

  const conflictReportPath = path.join(targetDir, "MEMO_LOG_CONFLICTS.md");
  try {
    const conflictContent = await fs.readFile(conflictReportPath, "utf8");
    events.push(...parseConflictReportEvents(conflictContent));
  } catch {
    // No conflict report available is valid.
  }

  // Sort deterministically by timestamp, then type, then filePath
  events.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp.localeCompare(b.timestamp);
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return (a.filePath ?? "").localeCompare(b.filePath ?? "");
  });

  return events;
}

function buildAuditExport(targetDir: string, events: AuditEvent[]): AuditExport {
  const exportedAt = new Date().toISOString();
  const scanTotals = events
    .map((event) => {
      const maybeTotal = event.details && typeof event.details["totalFiles"] === "number"
        ? event.details["totalFiles"]
        : undefined;
      return maybeTotal;
    })
    .filter((value): value is number => typeof value === "number");
  const uniqueChangedFiles = new Set(
    events
      .filter((event) => event.type === "change" && typeof event.filePath === "string")
      .map((event) => event.filePath as string),
  ).size;
  const totalFiles = scanTotals.length > 0
    ? scanTotals[scanTotals.length - 1]!
    : uniqueChangedFiles;

  const body = {
    schemaVersion: AUDIT_SCHEMA_VERSION as 1,
    exportedAt,
    targetDir,
    events,
    totalFiles,
  };
  // Keep hash deterministic over semantic payload, not export timestamp.
  const hashInput = {
    schemaVersion: body.schemaVersion,
    targetDir: body.targetDir,
    events: body.events,
    totalFiles: body.totalFiles,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(hashInput), "utf8")
    .digest("hex");
  return { ...body, hash };
}

function renderAuditText(audit: AuditExport): string {
  const lines: string[] = [
    "memo-log Audit Trail",
    `Exported: ${audit.exportedAt}`,
    `Target: ${audit.targetDir}`,
    `Total events: ${audit.events.length}`,
    `Hash: ${audit.hash}`,
    "",
    "Events:",
  ];
  for (const event of audit.events) {
    const detail = event.details ? ` — ${JSON.stringify(event.details)}` : "";
    const file = event.filePath ? ` [${event.filePath}]` : "";
    lines.push(`  [${event.type.toUpperCase()}] ${event.timestamp}${file}${detail}`);
  }
  lines.push("");
  lines.push("✓ Zero LLM calls · Zod-validated · SHA-256 signed");
  return lines.join("\n");
}

async function atomicWriteFile(outPath: string, content: string): Promise<void> {
  const { randomUUID } = await import("node:crypto");
  const tmp = `${outPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, outPath);
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

