import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";
import {
  ARCHIVE_TICKETS_DIR,
  planCompact,
  runCompact,
} from "../src/cli/compact.js";
import { TicketSchema, type Ticket } from "../src/types/ticket.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeTicket(
  id: string,
  state: Ticket["state"],
  impactScore: number,
  createdAt: string,
): Ticket {
  return TicketSchema.parse({
    schemaVersion: 1,
    id,
    title: `Ticket ${id}`,
    state,
    createdAt,
    updatedAt: createdAt,
    summary: "1 added, 0 modified, 0 removed; 0 breaking change(s); 1 checklist item(s)",
    impactScore,
    changes: [
      {
        path: "src/utils/a.ts",
        changeType: "ADDED",
        category: "utils",
        exportsAdded: ["a"],
        exportsRemoved: [],
        signaturesChanged: [],
        impactScore,
      },
    ],
    checklist: [
      {
        id: "C-000000000001",
        rule: "file_added",
        text: "File `src/utils/a.ts` was added.",
        ref: "[src/utils/a.ts:1]",
        status: "pending",
        verified: true,
      },
    ],
    artifacts: [{ kind: "file", path: "src/utils/a.ts" }],
    stateHistory: [{ state, at: createdAt, actor: "human" }],
  });
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

const TICKETS = [
  makeTicket("T-000000000001", "done", 0.9, "2026-01-05T00:00:00.000Z"),
  makeTicket("T-000000000002", "done", 0.1, "2026-01-04T00:00:00.000Z"),
  makeTicket("T-000000000003", "open", 0.05, "2026-01-03T00:00:00.000Z"),
  makeTicket("T-000000000004", "done", 0.2, "2026-01-02T00:00:00.000Z"),
  makeTicket("T-000000000005", "done", 0.05, "2026-01-01T00:00:00.000Z"),
];

describe("compact", () => {
  it("keeps the newest N tickets and every non-done ticket", () => {
    const plan = planCompact(TICKETS, { keepRecent: 1, minSignificance: "medium" });

    expect(plan.kept.map((ticket) => ticket.id)).toEqual([
      "T-000000000001",
      "T-000000000003",
    ]);
    expect(plan.archived.map((ticket) => ticket.id)).toEqual([
      "T-000000000002",
      "T-000000000004",
      "T-000000000005",
    ]);
    expect(plan.threshold).toBe(0.33);
  });

  it("keeps high-impact done tickets regardless of age", () => {
    const plan = planCompact(TICKETS, { keepRecent: 0, minSignificance: "high" });

    expect(plan.kept.map((ticket) => ticket.id)).toContain("T-000000000001");
    expect(plan.archived.map((ticket) => ticket.id)).toEqual([
      "T-000000000002",
      "T-000000000004",
      "T-000000000005",
    ]);
  });

  it("low significance keeps everything", () => {
    const plan = planCompact(TICKETS, { keepRecent: 0, minSignificance: "low" });
    expect(plan.archived).toHaveLength(0);
    expect(plan.kept).toHaveLength(TICKETS.length);
  });

  it("archives ticket files atomically without deleting them", async () => {
    const root = await makeTempDir("memolog-compact-");
    const ticketsDir = path.join(root, ".memo-log", "tickets");
    await fs.mkdir(ticketsDir, { recursive: true });
    for (const ticket of TICKETS) {
      await fs.writeFile(
        path.join(ticketsDir, `${ticket.id}.json`),
        `${JSON.stringify(ticket, null, 2)}\n`,
        "utf8",
      );
      await fs.writeFile(path.join(ticketsDir, `${ticket.id}.md`), "# ticket\n", "utf8");
    }

    const result = runCompact({ rootDir: root, keepRecent: 1, minSignificance: "medium" });

    expect(result.total).toBe(5);
    expect(result.archived.map((ticket) => ticket.id)).toEqual([
      "T-000000000002",
      "T-000000000004",
      "T-000000000005",
    ]);

    const archiveDir = path.join(root, ARCHIVE_TICKETS_DIR);
    for (const id of ["T-000000000002", "T-000000000004", "T-000000000005"]) {
      await expect(fs.stat(path.join(ticketsDir, `${id}.json`))).rejects.toThrow();
      await expect(fs.stat(path.join(archiveDir, `${id}.json`))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(archiveDir, `${id}.md`))).resolves.toBeTruthy();
    }
    await expect(fs.stat(path.join(ticketsDir, "T-000000000001.json"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(ticketsDir, "T-000000000003.json"))).resolves.toBeTruthy();
  });

  it("dry run reports the plan without moving files", async () => {
    const root = await makeTempDir("memolog-compact-dry-");
    const ticketsDir = path.join(root, ".memo-log", "tickets");
    await fs.mkdir(ticketsDir, { recursive: true });
    const ticket = TICKETS[4]!;
    await fs.writeFile(
      path.join(ticketsDir, `${ticket.id}.json`),
      `${JSON.stringify(ticket, null, 2)}\n`,
      "utf8",
    );

    const result = runCompact({
      rootDir: root,
      keepRecent: 0,
      minSignificance: "medium",
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.archived).toHaveLength(1);
    await expect(fs.stat(path.join(ticketsDir, `${ticket.id}.json`))).resolves.toBeTruthy();
  });

  it("supports --json through the CLI", async () => {
    const root = await makeTempDir("memolog-compact-cli-");
    const ticketsDir = path.join(root, ".memo-log", "tickets");
    await fs.mkdir(ticketsDir, { recursive: true });
    for (const ticket of TICKETS) {
      await fs.writeFile(
        path.join(ticketsDir, `${ticket.id}.json`),
        `${JSON.stringify(ticket, null, 2)}\n`,
        "utf8",
      );
    }

    const capture = captureStdout();
    let exitCode: number;
    try {
      exitCode = await runCli([
        "compact",
        root,
        "--keep-recent",
        "0",
        "--min-significance",
        "high",
        "--dry-run",
        "--json",
      ]);
    } finally {
      capture.restore();
    }

    expect(exitCode).toBe(0);
    const payload = JSON.parse(capture.chunks.join("").trim()) as {
      kind: string;
      dryRun: boolean;
      archived: Array<{ id: string }>;
    };
    expect(payload.kind).toBe("memo-log-compact");
    expect(payload.dryRun).toBe(true);
    expect(payload.archived).toHaveLength(3);
  });
});
