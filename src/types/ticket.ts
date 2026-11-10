import { z } from "zod";

import { CategorySchema } from "./categories.js";

// Kept local so the pure type module does not import the engine layer.
const FileRefSchema = z
  .string()
  .regex(/^\[.+:\d+(?::\d+)?\]$/, "Checklist references must look like [file:line]");

/**
 * Accepted evidence forms: `[file:line]`, a commit sha, `test:<name>`, or
 * `log:<hash>`. Nothing free-form, so evidence stays mechanically checkable.
 */
export const EVIDENCE_PATTERN =
  /^(?:\[[^\]]+:\d+(?::\d+)?\]|[0-9a-f]{7,40}|test:[^\s].{0,198}|log:[0-9a-f]{12,64})$/;
export const EVIDENCE_MESSAGE =
  "Evidence must be [file:line], a commit sha, test:<name>, or log:<hash>";

// Deterministic session ticket schema.
//
// Every checklist item must be mechanically derived from code facts and carry a
// [file:line] reference. Human-only work is represented by an explicit TODO
// placeholder, never by generated intent.

export const TicketStateSchema = z.enum(["open", "needs_review", "done", "blocked", "superseded"]);
export type TicketState = z.infer<typeof TicketStateSchema>;

export const ChecklistRuleSchema = z.enum([
  "file_added",
  "file_modified",
  "file_removed",
  "export_added",
  "export_removed",
  "signature_changed",
  "export_kind_changed",
  "related_test_parses",
  "relative_imports_resolve",
  "relative_imports_unresolved",
  "no_removed_exports",
  "group_review",
]);
export type ChecklistRule = z.infer<typeof ChecklistRuleSchema>;

export const ChangeGroupKindSchema = z.enum([
  "baseline",
  "api_break",
  "api_add",
  "behavior",
  "rename_move",
  "reexport_churn",
  "deps",
  "generated",
  "formatting",
  "tests",
  "config_ci",
  "docs",
  "security_sink",
  "misc",
]);
export type ChangeGroupKind = z.infer<typeof ChangeGroupKindSchema>;

export const ChangeGroupRiskSchema = z.enum(["P0", "P1", "P2", "P3"]);
export type ChangeGroupRisk = z.infer<typeof ChangeGroupRiskSchema>;

/** One deterministic, reference-only fact used to form a change group. */
export interface ChangeFact {
  id: string;
  kindHints: ChangeGroupKind[];
  path: string;
  oldPath?: string | undefined;
  symbol?: string | undefined;
  oldSignature?: string | undefined;
  newSignature?: string | undefined;
  hunkId: string;
  refs: AuditRef[];
}

/** One drill-down row inside a change group. Summary surfaces omit these. */
export const AuditRefSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    ref: FileRefSchema,
    contentHash: z.string().min(1).optional(),
    symbol: z.string().min(1).optional(),
    rule: z.string().min(1).optional(),
  })
  .strict();

export type AuditRef = z.infer<typeof AuditRefSchema>;

export const ChangeGroupSchema = z
  .object({
    id: z.string().regex(/^G:[0-9a-f]{16}$/, "Group id must look like G:<16 hex chars>"),
    kind: ChangeGroupKindSchema,
    scopeKey: z.string().min(1),
    title: z.string().min(1).max(200),
    risk: ChangeGroupRiskSchema,
    hunkIds: z.array(z.string().regex(/^H:[0-9a-f]{16}$/)).default([]),
    factIds: z.array(z.string().regex(/^F:[0-9a-f]{16}$/)).default([]),
    fileCount: z.number().int().min(0),
    lineCount: z.number().int().min(0).default(0),
    auditRefCount: z.number().int().min(0),
    summaryStats: z.record(z.string(), z.number()),
    audit: z.array(AuditRefSchema),
  })
  .strict();

export type ChangeGroup = z.infer<typeof ChangeGroupSchema>;

export const ChecklistItemSchema = z
  .object({
    id: z.string().min(1),
    rule: ChecklistRuleSchema,
    text: z.string().min(1).max(500),
    ref: FileRefSchema,
    /** Human acceptance state. Generated items always start pending. */
    status: z.enum(["pending", "done"]).default("pending"),
    /** True when the fact was derived from a deterministic scan. */
    verified: z.boolean(),
    /** Group reviewed by this row; absent on legacy checklist rows. */
    groupId: z.string().regex(/^G:[0-9a-f]{16}$/).optional(),
    /**
     * Evidence attached when the item was checked off (F-12). Required to
     * mark an item done; cleared when the item returns to pending.
     */
    evidence: z.string().regex(EVIDENCE_PATTERN, EVIDENCE_MESSAGE).optional(),
  })
  .strict();

export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const ChangeSetSchema = z
  .object({
    path: z.string().min(1),
    changeType: z.enum(["ADDED", "MODIFIED", "REMOVED"]),
    category: CategorySchema,
    exportsAdded: z.array(z.string().min(1)),
    exportsRemoved: z.array(z.string().min(1)),
    signaturesChanged: z.array(z.string().min(1)),
    impactScore: z.number().min(0).max(1),
  })
  .strict();

export type ChangeSet = z.infer<typeof ChangeSetSchema>;

export const ArtifactLinkSchema = z
  .object({
    kind: z.enum(["file", "test", "docs", "commit", "session"]),
    path: z.string().min(1).optional(),
    ref: FileRefSchema.optional(),
    sha: z.string().min(1).optional(),
  })
  .strict();

export type ArtifactLink = z.infer<typeof ArtifactLinkSchema>;

export const TicketStateEventSchema = z
  .object({
    state: TicketStateSchema,
    at: z.string().datetime(),
    actor: z.enum(["human", "memo-log"]),
  })
  .strict();

export type TicketStateEvent = z.infer<typeof TicketStateEventSchema>;

export const TicketSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^T-[0-9a-f]{12}$/, "Ticket id must look like T-<12 hex chars>"),
    title: z.string().min(1).max(200),
    state: TicketStateSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    sessionId: z.string().min(1).optional(),
    label: z.string().min(1).max(120).optional(),
    summary: z.string().min(1).max(1000),
    impactScore: z.number().min(0).max(1),
    changes: z.array(ChangeSetSchema),
    /** Grouped review surface. Empty for tickets materialized before M1. */
    groups: z.array(ChangeGroupSchema).default([]),
    checklist: z.array(ChecklistItemSchema),
    artifacts: z.array(ArtifactLinkSchema),
    blockedReason: z.string().min(1).max(500).optional(),
    supersededBy: z.string().regex(/^T-[0-9a-f]{12}$/).optional(),
    staleReason: z.string().min(1).max(500).optional(),
    stateHistory: z.array(TicketStateEventSchema).default([]),
  })
  .strict();

export type Ticket = z.infer<typeof TicketSchema>;

export const SessionStatusSchema = z.enum(["active", "ended"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^S-[0-9a-f]{12}$/, "Session id must look like S-<12 hex chars>"),
    label: z.string().min(1).max(120).optional(),
    status: SessionStatusSchema,
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
    baselineStatePath: z.string().min(1),
    ticketId: z.string().regex(/^T-[0-9a-f]{12}$/).optional(),
  })
  .strict();

export type Session = z.infer<typeof SessionSchema>;
