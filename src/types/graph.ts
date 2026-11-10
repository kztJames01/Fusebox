import { z } from "zod";

// Deterministic Structural Graph Schema.
//
// Every node and edge is derived from local AST extracts, tickets, sessions,
// cards, and commit artifacts. No embeddings, no fuzzy matching, no network.
// Node IDs are deterministic: `<Kind>:<canonicalKey>:<contentHash12>`.

export const GraphNodeKindSchema = z.enum([
  "File",
  "Symbol",
  "Ticket",
  "Session",
  "Card",
  "Dependency",
  "Commit",
]);
export type GraphNodeKind = z.infer<typeof GraphNodeKindSchema>;

export const GraphEdgeTypeSchema = z.enum([
  "imports",
  "exports",
  "defines",
  "references",
  "touched_by_commit",
  "changed_in",
  "ticket_to_done_when_to_evidence",
  "card_replaces_card",
  "has_card",
  "depends_on",
]);
export type GraphEdgeType = z.infer<typeof GraphEdgeTypeSchema>;

/** Fixed, documented edge-type weights used in explainable traversal ranking. */
export const EDGE_TYPE_WEIGHTS: Readonly<Record<GraphEdgeType, number>> = {
  defines: 1.0,
  exports: 0.95,
  imports: 0.9,
  depends_on: 0.85,
  ticket_to_done_when_to_evidence: 0.95,
  changed_in: 0.85,
  touched_by_commit: 0.8,
  has_card: 0.9,
  card_replaces_card: 0.75,
  references: 0.8,
};

/** Default explainable ranking factor weights (hop, edgeWeight, recency, degree). */
export const GRAPH_RANK_WEIGHTS = {
  hop: 0.4,
  edgeWeight: 0.3,
  recency: 0.15,
  degree: 0.15,
} as const;

export const GraphNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: GraphNodeKindSchema,
    /** Canonical lookup key: relative file path, `file#symbol`, ticket ID, session ID, card ID, package name, or commit SHA. */
    key: z.string().min(1),
    label: z.string().min(1),
    /** Verifiable source reference (`[file:line]`, commit SHA, ticket ID, or card ID). */
    ref: z.string().min(1),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    updatedAt: z.string().optional(),
    meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .strict();
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z
  .object({
    id: z.string().min(1),
    type: GraphEdgeTypeSchema,
    from: z.string().min(1),
    to: z.string().min(1),
    /** Source `[file:line]`, commit SHA, or ticket/card reference anchoring this relation. */
    ref: z.string().min(1),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const ScoreBreakdownSchema = z
  .object({
    hop: z.number().min(0).max(1),
    edgeWeight: z.number().min(0).max(1),
    recency: z.number().min(0).max(1),
    degree: z.number().min(0).max(1),
    total: z.number().min(0).max(1),
  })
  .strict();
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

export const RankedGraphNodeSchema = z
  .object({
    node: GraphNodeSchema,
    hopDistance: z.number().int().nonnegative(),
    viaEdgeType: GraphEdgeTypeSchema.optional(),
    score: z.number().min(0).max(1),
    breakdown: ScoreBreakdownSchema,
  })
  .strict();
export type RankedGraphNode = z.infer<typeof RankedGraphNodeSchema>;

export const PersistedGraphSchema = z
  .object({
    schema: z.literal(1),
    integrityHash: z.string().regex(/^[0-9a-f]{64}$/),
    fileHashes: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
    nodes: z.array(GraphNodeSchema),
    edges: z.array(GraphEdgeSchema),
  })
  .strict();
export type PersistedGraph = z.infer<typeof PersistedGraphSchema>;
