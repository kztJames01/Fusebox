// MCP tool implementations.
//
// Every response is derived from local files only: MEMO_LOG.json, the parse
// cache, sessions, tickets, cards, and the deterministic structural graph.
import { z } from "zod";

import { CliError, ExitCode } from "../engine/errors.js";
import { loadEffectiveConfig } from "../engine/config.js";
import {
  checklistProgress,
  markChecklistItem,
} from "../engine/ticketCommands.js";
import { loadTicket, loadTickets } from "../engine/tickets.js";
import { ClaimBundleSchema } from "../engine/claimVerification.js";
import { TypeScriptChangeEngine } from "../engine/changeEngine.js";
import { attributionStatus, checkpointAttribution, listAttributionSpans } from "../engine/attribution.js";
import {
  loadCurrentSession,
  loadSession,
} from "../engine/sessions.js";
import { buildQueryPayload, loadTicketList } from "../engine/contextQuery.js";
import {
  buildBoardModel,
  buildInboxModel,
  toReviewTicketSummary,
  type ReviewFilters,
} from "../engine/reviewModel.js";
import { cardsForScope, getCard, listCards, toPortableCard } from "../engine/cards.js";
import {
  buildGraphContextPack,
  findGraphPath,
  queryGraph,
  renderGraphMermaid,
} from "../engine/graph.js";
import { startReviewServer, type ReviewServerHandle } from "../server/reviewServer.js";
import type { AnalysisEngine } from "../engine/rustCore.js";
import type { IndexStore } from "../engine/indexStore.js";
import { CardScopeSchema, CardTypeSchema } from "../types/cards.js";
import { CategorySchema } from "../types/categories.js";
import { GraphEdgeTypeSchema } from "../types/graph.js";
import {
  ChangeGroupKindSchema,
  TicketStateSchema,
  type Ticket,
} from "../types/ticket.js";

export interface ToolContext {
  rootDir: string;
  /**
   * Write tools are opt-in. The server only advertises and executes
   * `mark_checklist_item` when this is explicitly enabled.
   */
  allowWrites?: boolean | undefined;
  /**
   * Analysis engine configured for this process. Reported on every tool
   * payload so agents can tell whether the Rust core was available.
   */
  engine?: AnalysisEngine | undefined;
  /**
   * Long-lived index handle owned by the server. When present, payloads carry
   * index counts so agents can see what the local index covers.
   */
  index?: IndexStore | undefined;
}

const ListTicketsArgsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    state: TicketStateSchema.optional(),
    category: CategorySchema.optional(),
    risk: z.enum(["P0", "P1", "P2", "P3"]).optional(),
    kind: ChangeGroupKindSchema.optional(),
  })
  .strict();

const GetTicketArgsSchema = z
  .object({
    ticketId: z.string().regex(/^T-[0-9a-f]{12}$/),
  })
  .strict();

const ReviewFilterShape = {
  q: z.string().max(200).optional(),
  priority: z.enum(["urgent", "high", "medium", "low"]).optional(),
  category: CategorySchema.optional(),
  state: TicketStateSchema.optional(),
};

const InboxArgsSchema = z
  .object({
    ...ReviewFilterShape,
    includeDone: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const BoardArgsSchema = z
  .object({
    ...ReviewFilterShape,
  })
  .strict();

const TicketGroupArgsSchema = z
  .object({
    ticketId: z.string().regex(/^T-[0-9a-f]{12}$/),
    groupId: z.string().min(1).max(120),
  })
  .strict();

const VerifyClaimsArgsSchema = z
  .object({
    schema: z.literal("memo-log.claims/v1").default("memo-log.claims/v1"),
    ticketId: z.string().regex(/^T-[0-9a-f]{12}$/),
    claims: z.array(z.unknown()).max(100),
  })
  .strict();

const AttributionCheckpointArgsSchema = z
  .object({
    sessionId: z.string().min(1).max(120),
    agentId: z.string().min(1).max(120),
    model: z.string().min(1).max(120).optional(),
    path: z.string().min(1).max(500),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    prevHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    seq: z.number().int().min(1).optional(),
  })
  .strict()
  .refine((value) => value.endLine >= value.startLine, {
    message: "endLine must be greater than or equal to startLine",
    path: ["endLine"],
  });

const GraphArgsSchema = z
  .object({
    op: z.enum(["query", "path", "pack", "mermaid"]).optional(),
    seed: z.string().min(1).max(300).optional(),
    from: z.string().min(1).max(300).optional(),
    to: z.string().min(1).max(300).optional(),
    edge_types: z.array(GraphEdgeTypeSchema).optional(),
    edgeTypes: z.array(GraphEdgeTypeSchema).optional(),
    depth: z.number().int().min(1).max(3).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    budget: z.number().int().min(20).max(100000).optional(),
    reorder: z.boolean().optional(),
  })
  .strict();

const QueryContextArgsSchema = z
  .object({
    category: CategorySchema.optional(),
    kind: z.string().min(1).max(40).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    audience: z.enum(["tech", "simple"]).optional(),
    structural: z.boolean().optional(),
    file: z.string().min(1).max(500).optional(),
    includeCards: z.boolean().optional(),
  })
  .strict();

const SessionSummaryArgsSchema = z
  .object({
    sessionId: z.string().regex(/^S-[0-9a-f]{12}$/).optional(),
  })
  .strict();

const ListCardsArgsSchema = z
  .object({
    cardId: z.string().regex(/^C-[0-9a-f]{12}$/).optional(),
    type: CardTypeSchema.optional(),
    scope: CardScopeSchema.optional(),
    file: z.string().min(1).max(500).optional(),
    ticketId: z.string().regex(/^T-[0-9a-f]{12}$/).optional(),
    includeReplaced: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const GetCardArgsSchema = z
  .object({
    cardId: z.string().regex(/^C-[0-9a-f]{12}$/),
  })
  .strict();

const GraphQueryArgsSchema = z
  .object({
    seed: z.string().min(1).max(300),
    edge_types: z.array(GraphEdgeTypeSchema).optional(),
    edgeTypes: z.array(GraphEdgeTypeSchema).optional(),
    depth: z.number().int().min(1).max(3).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const GraphPathArgsSchema = z
  .object({
    from: z.string().min(1).max(300),
    to: z.string().min(1).max(300),
  })
  .strict();

const ContextPackArgsSchema = z
  .object({
    seed: z.string().min(1).max(300),
    budget: z.number().int().min(20).max(100000).optional(),
    depth: z.number().int().min(1).max(3).optional(),
    reorder: z.boolean().optional(),
  })
  .strict();

const ReviewOpenArgsSchema = z
  .object({
    port: z.number().int().min(0).max(65535).optional(),
    idleMinutes: z.number().int().min(1).max(240).optional(),
  })
  .strict();

const activeReviewHandles = new Map<string, ReviewServerHandle>();

const MarkChecklistArgsSchema = z
  .object({
    ticketId: z.string().regex(/^T-[0-9a-f]{12}$/),
    item: z.string().min(1).optional(),
    groupId: z.string().regex(/^G:[0-9a-f]{16}$/).optional(),
    bulk: z.enum(["all", "p2_or_lower"]).optional(),
    status: z.enum(["pending", "done"]).optional(),
    evidence: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => value.item !== undefined || value.groupId !== undefined || value.bulk !== undefined, {
    message: "Provide an item, groupId, or bulk scope.",
  });

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_READ_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "inbox",
    description:
      "Return the review inbox: tickets awaiting human attention, grouped by state with priority, checklist progress, and [file:line] references. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search id, title, summary, label, category, or path" },
        priority: { type: "string", enum: ["urgent", "high", "medium", "low"] },
        category: { type: "string" },
        state: { type: "string", enum: ["open", "needs_review", "done", "blocked", "superseded"] },
        includeDone: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "board",
    description:
      "Return all tickets as deterministic state columns (open, needs_review, blocked, done) with counts and checklist progress. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search id, title, summary, label, category, or path" },
        priority: { type: "string", enum: ["urgent", "high", "medium", "low"] },
        category: { type: "string" },
        state: { type: "string", enum: ["open", "needs_review", "done", "blocked", "superseded"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "context",
    description:
      "Return a ranked, reference-anchored context slice (same engine as query_context). Set structural=true and file to include dependencies. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string" },
        kind: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        audience: { type: "string", enum: ["tech", "simple"], default: "tech" },
        structural: { type: "boolean" },
        file: { type: "string" },
        includeCards: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "graph",
    description:
      "One deterministic graph surface. op=query traverses around a seed; op=path finds a shortest path; op=pack builds a token-budgeted pack; op=mermaid renders Mermaid. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["query", "path", "pack", "mermaid"], default: "query" },
        seed: { type: "string", description: "File, file#symbol, ticket, card, or node id" },
        from: { type: "string" },
        to: { type: "string" },
        edge_types: { type: "array", items: { type: "string" } },
        depth: { type: "integer", minimum: 1, maximum: 3 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        budget: { type: "integer", minimum: 20, maximum: 100000 },
        reorder: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ticket_list",
    description:
      "List deterministic tickets, newest first, with optional state/category filters. Alias-compatible with list_recent_tickets. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        state: { type: "string", enum: ["open", "needs_review", "done", "blocked", "superseded"] },
        category: { type: "string" },
        risk: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        kind: { type: "string", enum: ChangeGroupKindSchema.options },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ticket_summary",
    description:
      "Return one ticket summary without checklist bodies: state, counts, priority, categories, and [file:line] references. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", pattern: "^T-[0-9a-f]{12}$" },
      },
      required: ["ticketId"],
      additionalProperties: false,
    },
  },
  {
    name: "ticket_group",
    description:
      "Expand one change group into its file:line audit refs. Tickets created before grouped review report that no groups are available. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", pattern: "^T-[0-9a-f]{12}$" },
        groupId: { type: "string" },
      },
      required: ["ticketId", "groupId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_recent_tickets",
    description:
      "List deterministic session tickets, newest first. Read-only. Every checklist item carries a [file:line] reference.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        state: { type: "string", enum: ["open", "needs_review", "done", "blocked", "superseded"] },
        category: { type: "string", description: "Change category filter" },
        risk: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        kind: { type: "string", enum: ChangeGroupKindSchema.options },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_ticket",
    description:
      "Return one ticket with its changes, checklist, artifacts, and state history. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", pattern: "^T-[0-9a-f]{12}$" },
      },
      required: ["ticketId"],
      additionalProperties: false,
    },
  },
  {
    name: "query_context",
    description:
      "Return a ranked, reference-anchored slice of MEMO_LOG.json. Reuses the same impact ranking as --export-context. Set structural=true (optionally with file) to merge recent diffs, category, and dependency sources. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string" },
        kind: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        audience: { type: "string", enum: ["tech", "simple"], default: "tech" },
        structural: {
          type: "boolean",
          description: "Merge recent structural changes, category, and dependency sources",
        },
        file: {
          type: "string",
          description: "Relative target file for structural dependents/dependencies",
        },
        includeCards: {
          type: "boolean",
          description: "Include scoped, size-capped user-authored memory cards (repo cards, plus folder cards matching file)",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_session_summary",
    description:
      "Return the current or requested session with its linked ticket and ticket state counts. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", pattern: "^S-[0-9a-f]{12}$" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_cards",
    description:
      "List or retrieve user-authored memory cards (preference, decision, constraint, convention) with references and SHA-256 hashes. Pass cardId to fetch a single card, or file/ticketId for scoped resolution. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", pattern: "^C-[0-9a-f]{12}$" },
        type: { type: "string", enum: ["preference", "decision", "constraint", "convention"] },
        scope: { type: "string", enum: ["repo", "folder", "ticket"] },
        file: { type: "string" },
        ticketId: { type: "string", pattern: "^T-[0-9a-f]{12}$" },
        includeReplaced: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_card",
    description: "Return one memory card by id with its SHA-256 hash. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        cardId: { type: "string", pattern: "^C-[0-9a-f]{12}$" },
      },
      required: ["cardId"],
      additionalProperties: false,
    },
  },
  {
    name: "graph_query",
    description:
      "Traverse the deterministic structural code-memory graph around a seed (file, symbol, ticket, card) up to depth<=3 with explainable score breakdowns (hop, edgeWeight, recency, degree). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        seed: { type: "string", description: "File path, file#symbol, ticket id, card id, or node id" },
        edge_types: {
          type: "array",
          items: {
            type: "string",
            enum: [
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
            ],
          },
        },
        depth: { type: "integer", minimum: 1, maximum: 3, default: 2 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      },
      required: ["seed"],
      additionalProperties: false,
    },
  },
  {
    name: "graph_path",
    description:
      "Find the deterministic shortest path between two graph nodes or references (`from` -> `to`). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  {
    name: "context_pack",
    description:
      "Build a ranked, token-budgeted, LongContextReordered pack of references and scoped memory cards around a seed node, reporting used tokens and what was cut. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        seed: { type: "string" },
        budget: { type: "integer", minimum: 20, maximum: 100000, default: 1200 },
        depth: { type: "integer", minimum: 1, maximum: 3, default: 2 },
        reorder: { type: "boolean", default: true },
      },
      required: ["seed"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_claims",
    description:
      "Verify a structured memo-log.claims/v1 bundle against ticket groups and hunks. Claims without a valid group or hunk cite fail. Returns deterministic supported, contradicted, or unverifiable verdicts with reference-only evidence. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        schema: { type: "string", const: "memo-log.claims/v1", default: "memo-log.claims/v1" },
        ticketId: { type: "string", pattern: "^T-[0-9a-f]{12}$" },
        claims: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, maxLength: 120 },
              op: { type: "string", minLength: 1, maxLength: 80 },
              args: { type: "object", default: {} },
              citeGroupIds: { type: "array", items: { type: "string" }, default: [] },
              citeHunkIds: { type: "array", items: { type: "string" }, default: [] },
              symbols: { type: "array", items: { type: "string" } },
              text: { type: "string", maxLength: 2000 },
            },
            required: ["id", "op"],
            additionalProperties: false,
          },
        },
      },
      required: ["ticketId", "claims"],
      additionalProperties: false,
    },
  },
  {
    name: "attribution_status",
    description: "Return local attribution spans and verify the per-session hash chain. Read-only.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string", minLength: 1, maxLength: 120 } },
      additionalProperties: false,
    },
  },
  {
    name: "review_open",
    description:
      "Start (or reuse) the local 127.0.0.1 review server and return the tokenized URLs so the user or IDE integrated browser can open it.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "integer", minimum: 0, maximum: 65535 },
        idleMinutes: { type: "integer", minimum: 1, maximum: 240, default: 30 },
      },
      additionalProperties: false,
    },
  },
] as const;

export const MCP_WRITE_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "mark_checklist_item",
    description:
      "Mark a checklist item done or pending. Disabled unless the server is started with --allow-writes; must only be called on an explicit human instruction.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string", pattern: "^T-[0-9a-f]{12}$" },
        item: { type: "string", description: "Checklist item id (C-...) or 1-based index" },
        groupId: { type: "string", pattern: "^G:[0-9a-f]{16}$", description: "Approve or undo one change group" },
        bulk: { type: "string", enum: ["all", "p2_or_lower"], description: "Approve all groups or all P2/P3 groups" },
        status: { type: "string", enum: ["pending", "done"], default: "done" },
        evidence: {
          type: "string",
          description: "Required when marking done: [file:line], commit sha, test:<name>, or log:<hash>",
        },
      },
      required: ["ticketId"],
      additionalProperties: false,
    },
  },
  {
    name: "attribution_checkpoint",
    description:
      "Record an explicit attribution checkpoint. Disabled unless the server is started with --allow-writes.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        agentId: { type: "string" },
        model: { type: "string" },
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
        endLine: { type: "integer", minimum: 1 },
        contentHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        prevHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        seq: { type: "integer", minimum: 1 },
      },
      required: ["sessionId", "agentId", "path", "startLine", "endLine"],
      additionalProperties: false,
    },
  },
  {
    name: "attribution.checkpoint",
    description: "Alias for attribution_checkpoint. Records an explicit attribution checkpoint; requires --allow-writes.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" }, agentId: { type: "string" }, model: { type: "string" },
        path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 },
        contentHash: { type: "string", pattern: "^[a-f0-9]{64}$" }, prevHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        seq: { type: "integer", minimum: 1 },
      },
      required: ["sessionId", "agentId", "path", "startLine", "endLine"],
      additionalProperties: false,
    },
  },
] as const;

/** Full surface, including write tools. Kept for documentation and tests. */
export const MCP_TOOLS: readonly McpToolDefinition[] = [
  ...MCP_READ_TOOLS,
  ...MCP_WRITE_TOOLS,
];

/**
 * Tools advertised and accepted for a given server instance. Write tools are
 * hidden unless the operator opted in with `--allow-writes`.
 */
export function listMcpTools(allowWrites: boolean): readonly McpToolDefinition[] {
  return allowWrites ? MCP_TOOLS : MCP_READ_TOOLS;
}

function summarizeTicket(ticket: Ticket): Record<string, unknown> {
  const progress = checklistProgress(ticket);
  const references = [...new Set(ticket.checklist.map((item) => item.ref))].sort((a, b) =>
    a.localeCompare(b),
  );
  return {
    id: ticket.id,
    title: ticket.title,
    state: ticket.state,
    summary: ticket.summary,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    ...(ticket.sessionId !== undefined ? { sessionId: ticket.sessionId } : {}),
    ...(ticket.blockedReason !== undefined ? { blockedReason: ticket.blockedReason } : {}),
    changeCount: ticket.changes.length,
    groupCount: ticket.groups.length,
    groups: ticket.groups.map((group) => ({
      id: group.id,
      kind: group.kind,
      risk: group.risk,
      title: group.title,
      fileCount: group.fileCount,
      lineCount: group.lineCount,
    })),
    checklist: progress,
    references,
  };
}

function reviewFiltersFrom(parsed: z.infer<typeof BoardArgsSchema>): ReviewFilters {
  return {
    q: parsed.q ?? "",
    priority: parsed.priority ?? "",
    category: parsed.category ?? "",
    ...(parsed.state !== undefined ? { state: parsed.state } : {}),
  };
}

function ticketCounts(tickets: readonly Ticket[]): Record<string, number> {
  const counts: Record<string, number> = {
    open: 0,
    needs_review: 0,
    done: 0,
    blocked: 0,
    superseded: 0,
  };
  for (const ticket of tickets) {
    counts[ticket.state] = (counts[ticket.state] ?? 0) + 1;
  }
  return counts;
}

function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    throw new CliError(
      `Invalid tool arguments: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
        .join("; ")}`,
      ExitCode.ConfigError,
    );
  }
  return parsed.data;
}

/**
 * Every tool payload carries `engine`, the analysis engine this server would
 * use. It is `ts` unless a Rust binary was explicitly discovered.
 */
export async function callMcpTool(
  name: string,
  args: unknown,
  context: ToolContext,
): Promise<Record<string, unknown>> {
  const payload = await callMcpToolPayload(name, args, context);
  return {
    ...payload,
    engine: context.engine ?? "ts",
    ...(context.index !== undefined ? { index: context.index.status() } : {}),
  };
}

async function callMcpToolPayload(
  name: string,
  args: unknown,
  context: ToolContext,
): Promise<Record<string, unknown>> {
  switch (name) {
    case "inbox": {
      const parsed = parseArgs(InboxArgsSchema, args);
      return buildInboxModel(loadTickets(context.rootDir), reviewFiltersFrom(parsed), {
        includeDone: parsed.includeDone === true,
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      }) as unknown as Record<string, unknown>;
    }

    case "board": {
      const parsed = parseArgs(BoardArgsSchema, args);
      return buildBoardModel(
        loadTickets(context.rootDir),
        reviewFiltersFrom(parsed),
      ) as unknown as Record<string, unknown>;
    }

    case "context": {
      const parsed = parseArgs(QueryContextArgsSchema, args);
      const loaded = await loadEffectiveConfig({ targetDir: context.rootDir });
      const payload = buildQueryPayload({
        rootDir: loaded.rootDir,
        jsonPath: loaded.config.output.json,
        ...(parsed.category !== undefined ? { category: parsed.category } : {}),
        ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
        ...(parsed.file !== undefined ? { file: parsed.file } : {}),
        structural: parsed.structural === true,
        includeCards: parsed.includeCards === true,
        limit: parsed.limit ?? 20,
        audience: parsed.audience ?? "tech",
        weights: loaded.config.ranking.weights,
      });
      return {
        ...payload,
        kind: "memo-log-mcp-context",
        view: "context",
      } as Record<string, unknown>;
    }

    case "graph": {
      const parsed = parseArgs(GraphArgsSchema, args);
      const op = parsed.op ?? "query";
      const edgeTypes = parsed.edge_types ?? parsed.edgeTypes;
      let result: unknown;
      if (op === "path") {
        if (parsed.from === undefined || parsed.to === undefined) {
          throw new CliError("graph op=path requires from and to.", ExitCode.ConfigError);
        }
        result = findGraphPath({
          rootDir: context.rootDir,
          from: parsed.from,
          to: parsed.to,
        });
      } else {
        if (parsed.seed === undefined) {
          throw new CliError(`graph op=${op} requires a seed.`, ExitCode.ConfigError);
        }
        if (op === "query") {
          result = queryGraph({
            rootDir: context.rootDir,
            seed: parsed.seed,
            ...(edgeTypes !== undefined ? { edgeTypes } : {}),
            ...(parsed.depth !== undefined ? { depth: parsed.depth } : {}),
            ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
          });
        } else if (op === "pack") {
          result = buildGraphContextPack({
            rootDir: context.rootDir,
            seed: parsed.seed,
            ...(parsed.budget !== undefined ? { budget: parsed.budget } : {}),
            ...(parsed.depth !== undefined ? { depth: parsed.depth } : {}),
            ...(parsed.reorder !== undefined ? { reorder: parsed.reorder } : {}),
          });
        } else {
          result = renderGraphMermaid({
            rootDir: context.rootDir,
            seed: parsed.seed,
            ...(parsed.depth !== undefined ? { depth: parsed.depth } : {}),
          });
        }
      }
      return {
        kind: "memo-log-mcp-graph",
        schema: 1,
        view: "graph",
        op,
        result,
      };
    }

    case "ticket_summary": {
      const parsed = parseArgs(GetTicketArgsSchema, args);
      const ticket = loadTicket(context.rootDir, parsed.ticketId);
      if (!ticket) {
        throw new CliError(`Ticket not found: ${parsed.ticketId}`, ExitCode.ConfigError);
      }
      return {
        kind: "memo-log-mcp-ticket-summary",
        schema: 1,
        ticket: toReviewTicketSummary(ticket),
      };
    }

    case "ticket_group": {
      const parsed = parseArgs(TicketGroupArgsSchema, args);
      const ticket = loadTicket(context.rootDir, parsed.ticketId);
      if (!ticket) {
        throw new CliError(`Ticket not found: ${parsed.ticketId}`, ExitCode.ConfigError);
      }
      const group = ticket.groups.find((candidate) => candidate.id === parsed.groupId);
      if (!group) {
        return {
          kind: "memo-log-mcp-ticket-group",
          schema: 1,
          status: ticket.groups.length === 0 ? "unavailable" : "not_found",
          ticketId: parsed.ticketId,
          groupId: parsed.groupId,
          reason: ticket.groups.length === 0
            ? "This ticket predates grouped review."
            : "Change group not found on this ticket.",
        };
      }
      return {
        kind: "memo-log-mcp-ticket-group",
        schema: 1,
        ticketId: parsed.ticketId,
        group,
        attributions: (await listAttributionSpans(context.rootDir)).filter((span) =>
          group.audit.some((ref) => ref.path === span.path && span.startLine <= ref.endLine && span.endLine >= ref.startLine),
        ),
      };
    }

    case "verify_claims": {
      const parsed = parseArgs(VerifyClaimsArgsSchema, args);
      const ticket = loadTicket(context.rootDir, parsed.ticketId);
      if (!ticket) {
        throw new CliError(`Ticket not found: ${parsed.ticketId}`, ExitCode.ConfigError);
      }
      const bundle = parseArgs(ClaimBundleSchema, {
        schema: parsed.schema,
        ticketId: parsed.ticketId,
        claims: parsed.claims,
      });
      return new TypeScriptChangeEngine().verifySummary(bundle, ticket) as unknown as Record<string, unknown>;
    }

    case "attribution_checkpoint":
    case "attribution.checkpoint": {
      if (context.allowWrites !== true) {
        throw new CliError(
          "Attribution checkpoints are disabled. Restart `memo-log mcp` with --allow-writes to enable explicit attribution writes.",
          ExitCode.ConfigError,
        );
      }
      const parsed = parseArgs(AttributionCheckpointArgsSchema, args);
      return await checkpointAttribution(context.rootDir, parsed) as unknown as Record<string, unknown>;
    }

    case "attribution_status": {
      const parsed = parseArgs(z.object({ sessionId: z.string().min(1).max(120).optional() }).strict(), args);
      return await attributionStatus(context.rootDir, parsed.sessionId) as unknown as Record<string, unknown>;
    }

    case "list_recent_tickets":
    case "ticket_list": {
      const parsed = parseArgs(ListTicketsArgsSchema, args);
      const tickets = loadTicketList({
        rootDir: context.rootDir,
        ...(parsed.state !== undefined ? { state: parsed.state } : {}),
        ...(parsed.category !== undefined ? { category: parsed.category } : {}),
        limit: 100,
      }).filter((ticket) => parsed.risk === undefined && parsed.kind === undefined || ticket.groups.some((group) =>
        (parsed.risk === undefined || group.risk === parsed.risk) &&
        (parsed.kind === undefined || group.kind === parsed.kind),
      )).slice(0, parsed.limit ?? 10);
      return {
        kind: "memo-log-mcp-list-tickets",
        schema: 1,
        tickets: tickets.map(summarizeTicket),
      };
    }

    case "get_ticket": {
      const parsed = parseArgs(GetTicketArgsSchema, args);
      const ticket = loadTicket(context.rootDir, parsed.ticketId);
      if (!ticket) {
        throw new CliError(`Ticket not found: ${parsed.ticketId}`, ExitCode.ConfigError);
      }
      return { kind: "memo-log-mcp-ticket", schema: 1, ticket };
    }

    case "query_context": {
      const parsed = parseArgs(QueryContextArgsSchema, args);
      const loaded = await loadEffectiveConfig({ targetDir: context.rootDir });
      return buildQueryPayload({
        rootDir: loaded.rootDir,
        jsonPath: loaded.config.output.json,
        ...(parsed.category !== undefined ? { category: parsed.category } : {}),
        ...(parsed.kind !== undefined ? { kind: parsed.kind } : {}),
        ...(parsed.file !== undefined ? { file: parsed.file } : {}),
        structural: parsed.structural === true,
        includeCards: parsed.includeCards === true,
        limit: parsed.limit ?? 20,
        audience: parsed.audience ?? "tech",
        weights: loaded.config.ranking.weights,
      });
    }

    case "get_session_summary": {
      const parsed = parseArgs(SessionSummaryArgsSchema, args);
      const session = parsed.sessionId !== undefined
        ? loadSession(context.rootDir, parsed.sessionId)
        : loadCurrentSession(context.rootDir);
      if (parsed.sessionId !== undefined && !session) {
        throw new CliError(`Session not found: ${parsed.sessionId}`, ExitCode.ConfigError);
      }

      const allTickets = loadTickets(context.rootDir);
      const sessionTickets = session
        ? allTickets.filter((ticket) => ticket.sessionId === session.id)
        : [];
      const linked = session?.ticketId !== undefined
        ? loadTicket(context.rootDir, session.ticketId)
        : null;

      return {
        kind: "memo-log-mcp-session-summary",
        schema: 1,
        session,
        ticket: linked ? summarizeTicket(linked) : null,
        tickets: sessionTickets.map(summarizeTicket),
        ticketCounts: ticketCounts(allTickets),
      };
    }

    case "list_cards": {
      const parsed = parseArgs(ListCardsArgsSchema, args);
      if (parsed.cardId !== undefined) {
        const found = getCard(context.rootDir, parsed.cardId);
        if (!found) {
          throw new CliError(`Card not found: ${parsed.cardId}`, ExitCode.ConfigError);
        }
        return {
          kind: "memo-log-mcp-card",
          schema: 1,
          card: { ...found, hash: toPortableCard(found).hash },
        };
      }
      const limit = parsed.limit ?? 20;
      const scoped =
        parsed.file !== undefined || parsed.ticketId !== undefined
          ? cardsForScope(
              context.rootDir,
              {
                ...(parsed.file !== undefined ? { file: parsed.file } : {}),
                ...(parsed.ticketId !== undefined ? { ticketId: parsed.ticketId } : {}),
              },
              limit,
            ).filter((card) =>
              (parsed.type === undefined || card.type === parsed.type) &&
              (parsed.scope === undefined || card.scope === parsed.scope),
            )
          : listCards(context.rootDir, {
              ...(parsed.type !== undefined ? { type: parsed.type } : {}),
              ...(parsed.scope !== undefined ? { scope: parsed.scope } : {}),
              includeReplaced: parsed.includeReplaced === true,
            }).slice(0, limit);
      return {
        kind: "memo-log-mcp-cards",
        schema: 1,
        cards: scoped.map(toPortableCard),
      };
    }

    case "get_card": {
      const parsed = parseArgs(GetCardArgsSchema, args);
      const found = getCard(context.rootDir, parsed.cardId);
      if (!found) {
        throw new CliError(`Card not found: ${parsed.cardId}`, ExitCode.ConfigError);
      }
      return {
        kind: "memo-log-mcp-card",
        schema: 1,
        card: { ...found, hash: toPortableCard(found).hash },
      };
    }

    case "graph_query": {
      const parsed = parseArgs(GraphQueryArgsSchema, args);
      const edgeTypes = parsed.edge_types ?? parsed.edgeTypes;
      return queryGraph({
        rootDir: context.rootDir,
        seed: parsed.seed,
        ...(edgeTypes !== undefined ? { edgeTypes } : {}),
        ...(parsed.depth !== undefined ? { depth: parsed.depth } : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      }) as unknown as Record<string, unknown>;
    }

    case "graph_path": {
      const parsed = parseArgs(GraphPathArgsSchema, args);
      return findGraphPath({
        rootDir: context.rootDir,
        from: parsed.from,
        to: parsed.to,
      }) as unknown as Record<string, unknown>;
    }

    case "context_pack": {
      const parsed = parseArgs(ContextPackArgsSchema, args);
      return buildGraphContextPack({
        rootDir: context.rootDir,
        seed: parsed.seed,
        ...(parsed.budget !== undefined ? { budget: parsed.budget } : {}),
        ...(parsed.depth !== undefined ? { depth: parsed.depth } : {}),
        ...(parsed.reorder !== undefined ? { reorder: parsed.reorder } : {}),
      }) as unknown as Record<string, unknown>;
    }

    case "review_open": {
      const parsed = parseArgs(ReviewOpenArgsSchema, args);
      const existing = activeReviewHandles.get(context.rootDir);
      const wantWrites = context.allowWrites === true;
      if (existing && existing.server.listening && existing.allowWrites === wantWrites) {
        return {
          kind: "memo-log-mcp-review-open",
          schema: 1,
          url: existing.url,
          inboxUrl: `http://${existing.host}:${existing.port}/t/${existing.token}/inbox`,
          boardUrl: `http://${existing.host}:${existing.port}/t/${existing.token}/board`,
          contextUrl: `http://${existing.host}:${existing.port}/t/${existing.token}/context`,
          graphUrl: `http://${existing.host}:${existing.port}/t/${existing.token}/graph`,
          host: existing.host,
          port: existing.port,
          allowWrites: existing.allowWrites,
        };
      }
      if (existing) {
        await existing.close();
        if (activeReviewHandles.get(context.rootDir) === existing) {
          activeReviewHandles.delete(context.rootDir);
        }
      }
      const handle = await startReviewServer({
        rootDir: context.rootDir,
        ...(parsed.port !== undefined ? { port: parsed.port } : {}),
        allowWrites: context.allowWrites === true,
        idleTimeoutMs: (parsed.idleMinutes ?? 30) * 60 * 1000,
      });
      handle.server.unref();
      activeReviewHandles.set(context.rootDir, handle);
      void handle.closed.then(() => {
        if (activeReviewHandles.get(context.rootDir) === handle) {
          activeReviewHandles.delete(context.rootDir);
        }
      });
      return {
        kind: "memo-log-mcp-review-open",
        schema: 1,
        url: handle.url,
        inboxUrl: `http://${handle.host}:${handle.port}/t/${handle.token}/inbox`,
        boardUrl: `http://${handle.host}:${handle.port}/t/${handle.token}/board`,
        contextUrl: `http://${handle.host}:${handle.port}/t/${handle.token}/context`,
        graphUrl: `http://${handle.host}:${handle.port}/t/${handle.token}/graph`,
        host: handle.host,
        port: handle.port,
        allowWrites: context.allowWrites === true,
      };
    }

    case "mark_checklist_item": {
      if (context.allowWrites !== true) {
        throw new CliError(
          "mark_checklist_item is disabled. Restart `memo-log mcp` with --allow-writes to enable explicit checklist updates.",
          ExitCode.ConfigError,
        );
      }
      const parsed = parseArgs(MarkChecklistArgsSchema, args);
      const result = markChecklistItem({
        rootDir: context.rootDir,
        ticketId: parsed.ticketId,
        item: parsed.item ?? "",
        ...(parsed.groupId !== undefined ? { groupId: parsed.groupId } : {}),
        ...(parsed.bulk !== undefined ? { bulk: parsed.bulk } : {}),
        status: parsed.status ?? "done",
        evidence: parsed.evidence,
      });
      return {
        kind: "memo-log-mcp-checklist-update",
        schema: 1,
        changed: result.changed,
        item: result.item,
        ticket: summarizeTicket(result.ticket),
      };
    }

    default:
      throw new CliError(`Unknown tool: ${name}`, ExitCode.ConfigError);
  }
}
