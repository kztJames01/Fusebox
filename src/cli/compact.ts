// Deterministic history compaction.
//
// Compact never deletes data. It moves low-significance, already-done tickets
// out of the active ticket directory into `.memo-log/archive/tickets`, keeping
// the newest N tickets and every high-impact ticket in place. Open, blocked,
// and needs-review tickets are always kept because they are active work.
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { CliError, ExitCode } from "../engine/errors.js";
import { loadTickets, TICKETS_DIR } from "../engine/tickets.js";
import type { Ticket } from "../types/ticket.js";

export const ARCHIVE_TICKETS_DIR = ".memo-log/archive/tickets";
export const DEFAULT_COMPACT_KEEP_RECENT = 10;

export const CompactSignificanceSchema = z.enum(["low", "medium", "high"]);
export type CompactSignificance = z.infer<typeof CompactSignificanceSchema>;

/**
 * Minimum impact score to keep. `low` keeps everything (no pruning), `medium`
 * prunes done tickets below 0.33, and `high` prunes done tickets below 0.66.
 */
export const COMPACT_SIGNIFICANCE_THRESHOLDS: Record<CompactSignificance, number> = {
  low: 0,
  medium: 0.33,
  high: 0.66,
};

export const CompactTicketSummarySchema = z
  .object({
    id: z.string().regex(/^T-[0-9a-f]{12}$/),
    state: z.enum(["open", "needs_review", "done", "blocked", "superseded"]),
    impactScore: z.number().min(0).max(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export const CompactResultSchema = z
  .object({
    kind: z.literal("memo-log-compact"),
    schema: z.literal(1),
    keepRecent: z.number().int().nonnegative(),
    minSignificance: CompactSignificanceSchema,
    threshold: z.number().min(0).max(1),
    dryRun: z.boolean(),
    total: z.number().int().nonnegative(),
    kept: z.array(CompactTicketSummarySchema),
    archived: z.array(CompactTicketSummarySchema),
  })
  .strict();

export type CompactResult = z.infer<typeof CompactResultSchema>;
export type CompactTicketSummary = z.infer<typeof CompactTicketSummarySchema>;

export interface CompactOptions {
  rootDir: string;
  keepRecent?: number | undefined;
  minSignificance?: CompactSignificance | undefined;
  dryRun?: boolean | undefined;
}

export function parseCompactSignificance(value: string | undefined): CompactSignificance {
  const parsed = CompactSignificanceSchema.safeParse(value ?? "medium");
  if (!parsed.success) {
    throw new CliError(
      `--min-significance must be one of: ${CompactSignificanceSchema.options.join(", ")}.`,
      ExitCode.ConfigError,
    );
  }
  return parsed.data;
}

function summarize(ticket: Ticket): CompactTicketSummary {
  return {
    id: ticket.id,
    state: ticket.state,
    impactScore: ticket.impactScore,
    createdAt: ticket.createdAt,
  };
}

/**
 * Pure decision function: which tickets stay active and which are archived.
 * Tickets arrive newest-first from `loadTickets`.
 */
export function planCompact(
  tickets: readonly Ticket[],
  options: { keepRecent: number; minSignificance: CompactSignificance },
): { kept: Ticket[]; archived: Ticket[]; threshold: number } {
  const threshold = COMPACT_SIGNIFICANCE_THRESHOLDS[options.minSignificance];
  const kept: Ticket[] = [];
  const archived: Ticket[] = [];

  tickets.forEach((ticket, index) => {
    const isRecent = index < options.keepRecent;
    const isPrunable =
      ticket.state === "done" &&
      !isRecent &&
      ticket.impactScore < threshold;
    if (isPrunable) {
      archived.push(ticket);
    } else {
      kept.push(ticket);
    }
  });

  return { kept, archived, threshold };
}

function archiveTicket(rootDir: string, ticket: Ticket): void {
  const sourceDir = join(rootDir, TICKETS_DIR);
  const archiveDir = join(rootDir, ARCHIVE_TICKETS_DIR);
  mkdirSync(archiveDir, { recursive: true });

  for (const extension of [".json", ".md"] as const) {
    const source = join(sourceDir, `${ticket.id}${extension}`);
    if (!existsSync(source)) {
      continue;
    }
    const destination = join(archiveDir, `${ticket.id}${extension}`);
    // rename over an existing archive entry is not portable on Windows.
    rmSync(destination, { force: true });
    renameSync(source, destination);
  }
}

export function runCompact(options: CompactOptions): CompactResult {
  const keepRecent = options.keepRecent ?? DEFAULT_COMPACT_KEEP_RECENT;
  if (!Number.isInteger(keepRecent) || keepRecent < 0) {
    throw new CliError(
      "--keep-recent must be a non-negative integer.",
      ExitCode.ConfigError,
    );
  }

  const minSignificance = options.minSignificance ?? "medium";
  const dryRun = options.dryRun === true;
  const tickets = loadTickets(options.rootDir);
  const plan = planCompact(tickets, { keepRecent, minSignificance });

  if (!dryRun) {
    try {
      for (const ticket of plan.archived) {
        archiveTicket(options.rootDir, ticket);
      }
    } catch (error) {
      throw new CliError(
        `Unable to archive ticket history: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ExitCode.RuntimeError,
      );
    }
  }

  return CompactResultSchema.parse({
    kind: "memo-log-compact",
    schema: 1,
    keepRecent,
    minSignificance,
    threshold: plan.threshold,
    dryRun,
    total: tickets.length,
    kept: plan.kept.map(summarize),
    archived: plan.archived.map(summarize),
  });
}

export function renderCompact(result: CompactResult): string {
  const lines: string[] = [
    `# Compact ${result.dryRun ? "(dry run)" : ""}`.trim(),
    "",
    `Tickets: ${result.total} total, ${result.kept.length} kept, ${result.archived.length} archived`,
    `Keep recent: ${result.keepRecent}  `,
    `Min significance: ${result.minSignificance} (impact >= ${result.threshold})`,
  ];

  if (result.archived.length === 0) {
    lines.push("", "No tickets matched the archive criteria.");
    return lines.join("\n");
  }

  lines.push("", "## Archived");
  for (const ticket of result.archived) {
    lines.push(
      `- \`${ticket.id}\` [${ticket.state}] impact ${ticket.impactScore.toFixed(4)} created ${ticket.createdAt}`,
    );
  }
  if (result.dryRun) {
    lines.push("", "Dry run: no files were moved.");
  } else {
    lines.push("", `Moved to \`${ARCHIVE_TICKETS_DIR}\`.`);
  }
  return lines.join("\n");
}
