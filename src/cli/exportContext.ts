// Selective, reference-anchored context pack for AI tools.
//
// The pack is deliberately small: only entries with a valid [file:line] ref are
// kept, entries are ranked by a deterministic impact heuristic, and a hard
// token budget prevents the "paste the whole repo" failure mode.
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import { PortableCardSchema, type PortableCard } from "../types/cards.js";
import { FileRefSchema } from "../engine/anti-hallucination.js";
import { CliError, ExitCode } from "../engine/errors.js";
import {
  inferKindFromTech,
  rankEntries,
  type ChangeStatus,
  type ImpactKind,
} from "../engine/impactRanking.js";
import type { DiffResult } from "../engine/diff.js";
import type { ConflictEntry } from "../engine/conflicts.js";
import {
  buildDependencyCounts,
  normalizeModulePath,
} from "../engine/moduleResolution.js";
import type { AstExtract } from "../types/scan.js";
import {
  CategorySchema,
  type Category,
} from "../types/categories.js";
import {
  DEFAULT_EXPORT_CONTEXT_MAX_TOKENS,
  DEFAULT_EXPORT_CONTEXT_CONFIG,
} from "../types/config.js";
import type { ImpactWeights } from "../types/ranking.js";

export const EXPORT_CONTEXT_FILE = "MEMO_LOG_CONTEXT.json";
export const EXPORT_CONTEXT_MARKDOWN_FILE = "MEMO_LOG_CONTEXT.md";
export { DEFAULT_EXPORT_CONTEXT_MAX_TOKENS };

export const ExportContextAudienceSchema = z.enum(["tech", "simple"]);
export type ExportContextAudience = z.infer<typeof ExportContextAudienceSchema>;

export const ExportContextOrderingSchema = z.enum(["ranked", "long-context-reorder"]);
export type ExportContextOrdering = z.infer<typeof ExportContextOrderingSchema>;

export const ExportContextEntrySchema = z
  .object({
    ref: FileRefSchema,
    category: CategorySchema,
    kind: z.enum(["function", "class", "type", "const", "default", "other"]),
    score: z.number().min(0).max(1),
    tech: z.string().min(1).optional(),
    simple: z.string().min(1).optional(),
  })
  .strict();

// Conflicting facts are surfaced only when the deterministic multi-agent
// conflict detector found HIGH/MEDIUM disagreements. They stay reference-only:
// every retained conflict must carry at least one valid [file:line] ref.
export const ExportContextConflictSchema = z
  .object({
    severity: z.enum(["HIGH", "MEDIUM"]),
    exportName: z.string().min(1),
    filePath: z.string().min(1),
    message: z.string().min(1),
    refs: z.array(FileRefSchema).min(1),
  })
  .strict();

export const ExportContextBudgetSchema = z
  .object({
    maxTokens: z.number().int().positive(),
    estimatedTokens: z.number().int().nonnegative(),
    truncated: z.boolean(),
    totalCandidates: z.number().int().nonnegative(),
  })
  .strict();

export const ExportContextSchema = z
  .object({
    kind: z.literal("memo-log-export-context"),
    schema: z.literal(2),
    audience: ExportContextAudienceSchema,
    ordering: ExportContextOrderingSchema,
    legend: z.array(z.string().min(1)).min(1),
    budget: ExportContextBudgetSchema,
    conflicts: z.array(ExportContextConflictSchema),
    /** Scoped user-authored cards (F-14). Omitted when there are none. */
    cards: z.array(PortableCardSchema).optional(),
    entries: z.array(ExportContextEntrySchema),
  })
  .strict();

export type ExportContext = z.infer<typeof ExportContextSchema>;
export type ExportContextEntry = z.infer<typeof ExportContextEntrySchema>;
export type ExportContextConflict = z.infer<typeof ExportContextConflictSchema>;

export interface BuildExportContextOptions {
  audience?: ExportContextAudience | undefined;
  maxTokens?: number | undefined;
  weights?: Partial<ImpactWeights> | undefined;
  diffResult?: DiffResult | undefined;
  extracts?: readonly AstExtract[] | undefined;
  /** LongContextReorder is on by default; set false for a plain ranked pack. */
  reorder?: boolean | undefined;
  /** Deterministic conflict entries from the multi-agent conflict detector. */
  conflicts?: readonly ConflictEntry[] | undefined;
  /** Scoped cards to include. Trimmed from the end if they do not fit the budget. */
  cards?: readonly PortableCard[] | undefined;
}

export interface WriteExportContextOptions extends BuildExportContextOptions {
  markdown?: boolean | undefined;
}

export interface ExportContextWriteResult {
  jsonPath: string;
  markdownPath?: string | undefined;
  payload: ExportContext;
}

interface Candidate {
  ref: string;
  category: Category;
  tech: string;
  simple: string;
  kind: ImpactKind;
}

const EXPORT_CONTEXT_LEGEND = [
  "Verified facts only: every entry is anchored to a [file:line] reference produced by a deterministic static scan.",
  "No LLM calls, no network, and no generated prose. Read the referenced source before acting.",
  "Entries are ranked by deterministic impact and reordered so the highest-impact facts sit at the start and end of the pack.",
  "If the token budget is exceeded, budget.truncated is true. Conflicts are reported only from the deterministic conflict detector.",
];

const MAX_EXPORT_CONTEXT_CONFLICTS = 10;

// LongContextReorder: keep the ranked order for selection, then distribute the
// selected facts so the most important ones land at the beginning *and* the end.
// This is a deterministic position transform; scores never change.
export function reorderLongContext<T>(items: readonly T[]): T[] {
  const front: T[] = [];
  const back: T[] = [];
  items.forEach((item, index) => {
    if (index % 2 === 0) {
      front.push(item);
    } else {
      back.unshift(item);
    }
  });
  return [...front, ...back];
}

function selectConflicts(
  conflicts: readonly ConflictEntry[] | undefined,
): ExportContextConflict[] {
  if (!conflicts || conflicts.length === 0) {
    return [];
  }

  const selected: ExportContextConflict[] = [];
  const seen = new Set<string>();
  for (const conflict of conflicts) {
    if (conflict.severity !== "HIGH" && conflict.severity !== "MEDIUM") {
      continue;
    }
    const refs = [conflict.agentARef, conflict.agentBRef]
      .filter((ref) => FileRefSchema.safeParse(ref).success);
    if (refs.length === 0) {
      // No verified location means the claim cannot be included.
      continue;
    }
    const key = `${conflict.severity}\u0000${conflict.filePath}\u0000${conflict.exportName}\u0000${conflict.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push({
      severity: conflict.severity,
      exportName: conflict.exportName,
      filePath: normalizeModulePath(conflict.filePath),
      message: conflict.message,
      refs,
    });
    if (selected.length >= MAX_EXPORT_CONTEXT_CONFLICTS) {
      break;
    }
  }

  return selected;
}

// Deterministic token estimate: roughly four characters per token. This is a
// budget guard, not a billing estimate, and it never depends on a tokenizer
// that could vary by platform.
export function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function refLocation(ref: string): { file: string; line: number } | null {
  const match = ref.match(/^\[(.+?):(\d+)(?::\d+)?\]$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { file: normalizeModulePath(match[1]), line: Number(match[2]) };
}

/** Normalized file path for a valid [file:line] ref, or null. */
export function refFilePath(ref: string): string | null {
  return refLocation(ref)?.file ?? null;
}

function buildKindMap(
  extracts: readonly AstExtract[],
): Map<string, ImpactKind> {
  const kinds = new Map<string, ImpactKind>();
  for (const extract of extracts) {
    const file = normalizeModulePath(extract.file);
    for (const exp of extract.exports) {
      kinds.set(`${file}:${exp.line}`, exp.kind as ImpactKind);
    }
  }
  return kinds;
}

function buildChangeMap(
  diffResult: DiffResult | undefined,
): Map<string, ChangeStatus> {
  const changes = new Map<string, ChangeStatus>();
  if (!diffResult) {
    return changes;
  }
  for (const change of diffResult.changes) {
    changes.set(normalizeModulePath(change.path), change.changeType);
  }
  return changes;
}

function maxMapValue(values: ReadonlyMap<string, number>): number {
  let max = 0;
  for (const value of values.values()) {
    if (value > max) {
      max = value;
    }
  }
  return max;
}

function collectCandidates(
  snapshot: unknown,
  audience: ExportContextAudience,
): Candidate[] {
  const obj =
    snapshot && typeof snapshot === "object"
      ? (snapshot as Record<string, unknown>)
      : {};
  const rawEntries = Array.isArray(obj["entries"])
    ? (obj["entries"] as unknown[])
    : [];

  const candidates: Candidate[] = [];
  const seenRefs = new Set<string>();
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const ref = typeof entry["ref"] === "string" ? entry["ref"] : "";
    if (!FileRefSchema.safeParse(ref).success) {
      continue;
    }
    // MEMO_LOG.json can contain the same ref more than once (for example after
    // a merge). A pack is a set of reference-anchored facts, so keep the first
    // occurrence instead of spending the token budget on duplicates.
    if (seenRefs.has(ref)) {
      continue;
    }

    const category = CategorySchema.safeParse(entry["category"]);
    if (!category.success) {
      continue;
    }

    const tech = typeof entry["tech"] === "string" ? entry["tech"].trim() : "";
    const simple = typeof entry["simple"] === "string" ? entry["simple"].trim() : "";
    const chosen = audience === "tech" ? tech : simple;
    if (chosen.length === 0) {
      continue;
    }

    seenRefs.add(ref);
    candidates.push({
      ref,
      category: category.data,
      tech,
      simple,
      kind: inferKindFromTech(tech || simple),
    });
  }

  return candidates;
}

function buildPayload(
  audience: ExportContextAudience,
  maxTokens: number,
  ordering: ExportContextOrdering,
  conflicts: readonly ExportContextConflict[],
  entries: ExportContextEntry[],
  truncated: boolean,
  totalCandidates: number,
  cards: readonly PortableCard[] = [],
): ExportContext {
  return {
    kind: "memo-log-export-context",
    schema: 2,
    audience,
    ordering,
    legend: [...EXPORT_CONTEXT_LEGEND],
    budget: {
      maxTokens,
      estimatedTokens: 0,
      truncated,
      totalCandidates,
    },
    conflicts: [...conflicts],
    ...(cards.length > 0 ? { cards: [...cards] } : {}),
    entries,
  };
}

function payloadTokens(payload: ExportContext): number {
  return estimateTokens(JSON.stringify(payload, null, 2));
}

/**
 * Rank every reference-anchored snapshot entry with the same deterministic
 * heuristic used by the context pack. Query uses this without a token budget.
 */
export function rankSnapshotEntries(
  snapshot: unknown,
  options: BuildExportContextOptions = {},
): ExportContextEntry[] {
  const audience = options.audience ?? "tech";
  const candidates = collectCandidates(snapshot, audience);
  const changeMap = buildChangeMap(options.diffResult);
  const kindMap = options.extracts ? buildKindMap(options.extracts) : new Map<string, ImpactKind>();
  const dependencyCounts = options.extracts
    ? buildDependencyCounts(options.extracts)
    : new Map<string, number>();

  const entriesInFile = new Map<string, number>();
  for (const candidate of candidates) {
    const location = refLocation(candidate.ref);
    if (!location) {
      continue;
    }
    entriesInFile.set(location.file, (entriesInFile.get(location.file) ?? 0) + 1);
  }
  const maxEntriesInFile = maxMapValue(entriesInFile);
  const maxDependentCount = maxMapValue(dependencyCounts);

  const ranked = rankEntries(
    candidates,
    (candidate) => {
      const location = refLocation(candidate.ref);
      const file = location?.file ?? "";
      const locationKey = location ? `${file}:${location.line}` : "";
      return {
        changeType: changeMap.get(file) ?? "UNKNOWN",
        entriesInFile: entriesInFile.get(file) ?? 0,
        maxEntriesInFile,
        dependentCount: dependencyCounts.get(file) ?? 0,
        maxDependentCount,
        kind: kindMap.get(locationKey) ?? candidate.kind,
      };
    },
    options.weights,
  );

  return ranked.map(({ entry, score }) => {
    const base = {
      ref: entry.ref,
      category: entry.category,
      kind: entry.kind,
      score: score.total,
    };
    return audience === "tech"
      ? { ...base, tech: entry.tech }
      : { ...base, simple: entry.simple };
  });
}

export function buildExportContext(
  snapshot: unknown,
  options: BuildExportContextOptions = {},
): ExportContext {
  const audience = options.audience ?? "tech";
  const maxTokens = options.maxTokens ?? DEFAULT_EXPORT_CONTEXT_MAX_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new CliError(
      `--max-tokens must be a positive integer (received "${String(maxTokens)}").`,
      ExitCode.ConfigError,
    );
  }

  const reorder = options.reorder ?? DEFAULT_EXPORT_CONTEXT_CONFIG.reorder;
  const ordering: ExportContextOrdering = reorder
    ? "long-context-reorder"
    : "ranked";
  const conflicts = selectConflicts(options.conflicts);
  const rankedEntries = rankSnapshotEntries(snapshot, options);
  let cards = [...(options.cards ?? [])];

  const orderSelected = (count: number): ExportContextEntry[] => {
    const selected = rankedEntries.slice(0, count);
    return reorder ? reorderLongContext(selected) : selected;
  };

  // The legend, budget metadata, and conflict block are mandatory, so a budget
  // below that floor cannot be honored. Fail fast instead of silently
  // exceeding it.
  const emptyPayload = buildPayload(
    audience,
    maxTokens,
    ordering,
    conflicts,
    [],
    rankedEntries.length > 0,
    rankedEntries.length,
    cards,
  );
  let minimumTokens = payloadTokens(emptyPayload);
  // Cards are optional context: drop the last ones before failing the budget.
  while (minimumTokens > maxTokens && cards.length > 0) {
    cards = cards.slice(0, -1);
    minimumTokens = payloadTokens(
      buildPayload(audience, maxTokens, ordering, conflicts, [], rankedEntries.length > 0, rankedEntries.length, cards),
    );
  }
  if (minimumTokens > maxTokens) {
    throw new CliError(
      `--max-tokens ${maxTokens} is too small; the legend and budget metadata need at least ~${minimumTokens} tokens.`,
      ExitCode.ConfigError,
    );
  }

  // Binary search for the largest ranked prefix that fits the token budget.
  // Selection uses impact rank; reordering happens afterwards so a low-impact
  // fact never displaces a high-impact one just to fill the middle.
  let low = 0;
  let high = rankedEntries.length;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidatePayload = buildPayload(
      audience,
      maxTokens,
      ordering,
      conflicts,
      orderSelected(mid),
      mid < rankedEntries.length,
      rankedEntries.length,
      cards,
    );
    if (payloadTokens(candidatePayload) <= maxTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  let included = best;
  let payload = buildPayload(
    audience,
    maxTokens,
    ordering,
    conflicts,
    orderSelected(included),
    included < rankedEntries.length,
    rankedEntries.length,
    cards,
  );

  // The estimate itself occupies bytes in the JSON. Iterate to a stable value,
  // then drop entries if the final serialization still exceeds the budget.
  for (;;) {
    for (let i = 0; i < 3; i++) {
      const next = payloadTokens(payload);
      if (next === payload.budget.estimatedTokens) {
        break;
      }
      payload.budget.estimatedTokens = next;
    }

    if (payloadTokens(payload) <= maxTokens || included === 0) {
      break;
    }

    included -= 1;
    payload = buildPayload(
      audience,
      maxTokens,
      ordering,
      conflicts,
      orderSelected(included),
      included < rankedEntries.length,
      rankedEntries.length,
      cards,
    );
  }

  const parsed = ExportContextSchema.safeParse(payload);
  if (!parsed.success) {
    throw new CliError(
      `EXPORT_CONTEXT_SCHEMA_VIOLATION: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ")}`,
      ExitCode.RuntimeError,
    );
  }

  return parsed.data;
}

export function renderExportContextMarkdown(payload: ExportContext): string {
  const lines: string[] = [
    "# Memo-log AI Context Pack",
    "",
    "> Verified facts only. Every item is anchored to a `[file:line]` reference from a deterministic static scan. No LLM calls, no network, no generated prose.",
    "",
    `**Audience:** ${payload.audience}  `,
    `**Ordering:** ${payload.ordering}  `,
    `**Budget:** ${payload.budget.maxTokens} tokens (estimated ${payload.budget.estimatedTokens})  `,
    `**Entries:** ${payload.entries.length} of ${payload.budget.totalCandidates}${
      payload.budget.truncated ? " (truncated)" : ""
    }`,
    "",
  ];

  if (payload.conflicts.length > 0) {
    lines.push(
      "## Conflicting facts",
      "",
      "> Reported by the deterministic multi-agent conflict detector. Resolve these before acting on the affected exports.",
      "",
    );
    for (const conflict of payload.conflicts) {
      lines.push(
        `- [${conflict.severity}] \`${conflict.exportName}\` in \`${conflict.filePath}\` — ${conflict.message}`,
      );
      lines.push(`  - refs: ${conflict.refs.join(", ")}`);
    }
    lines.push("");
  }

  if (payload.cards !== undefined && payload.cards.length > 0) {
    lines.push(
      "## Project cards",
      "",
      "> Written by the user, not generated. Each card is anchored to references and carries a hash you can verify.",
      "",
    );
    for (const card of payload.cards) {
      lines.push(`- **${card.type}** (${card.scope}) ${card.content}`);
      lines.push(`  - refs: ${card.refs.join(", ")}`);
      lines.push(`  - hash: ${card.hash}`);
    }
    lines.push("");
  }

  lines.push("## Ranked facts", "");

  if (payload.entries.length === 0) {
    lines.push("_No verifiable entries fit the token budget._");
  } else {
    for (const entry of payload.entries) {
      const text = entry.tech ?? entry.simple ?? "";
      lines.push(
        `- ${text} ${entry.ref} _(category: ${entry.category}, score: ${entry.score.toFixed(4)})_`,
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

function atomicWrite(filePath: string, content: string): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const tempPath = join(directory, `.tmp-${randomUUID()}.tmp`);
  writeFileSync(tempPath, content, "utf8");
  try {
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

export function writeExportContext(
  targetDir: string,
  jsonPath?: string,
  snapshot?: unknown,
  options: WriteExportContextOptions = {},
): ExportContextWriteResult {
  const root = resolve(targetDir);

  let source: unknown = snapshot;
  if (source === undefined) {
    const sourcePath = jsonPath ?? join(root, "MEMO_LOG.json");
    try {
      source = JSON.parse(readFileSync(sourcePath, "utf8")) as unknown;
    } catch (error) {
      throw new CliError(
        `Unable to read ${sourcePath} for --export-context: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ExitCode.RuntimeError,
      );
    }
  }

  const payload = buildExportContext(source, options);
  const outPath = join(root, EXPORT_CONTEXT_FILE);
  atomicWrite(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  const result: ExportContextWriteResult = { jsonPath: outPath, payload };
  if (options.markdown === true) {
    const markdownPath = join(root, EXPORT_CONTEXT_MARKDOWN_FILE);
    atomicWrite(markdownPath, renderExportContextMarkdown(payload));
    result.markdownPath = markdownPath;
  }

  return result;
}
