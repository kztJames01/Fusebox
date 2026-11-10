import { z } from "zod";

// Typed memory cards (F-9).
//
// A card is a short user-authored statement with mandatory references. Memo-log
// never generates card content. Replacement is explicit and linked, never a
// silent merge.

export const CardTypeSchema = z.enum(["preference", "decision", "constraint", "convention"]);
export type CardType = z.infer<typeof CardTypeSchema>;

export const CardScopeSchema = z.enum(["repo", "folder", "ticket"]);
export type CardScope = z.infer<typeof CardScopeSchema>;

/**
 * Accepted reference forms: `[file:line]`, a commit sha, a ticket id, or a
 * `sha256:<64 hex>` content hash.
 */
export const CARD_REF_PATTERN =
  /^(?:\[[^\]]+:\d+(?::\d+)?\]|[0-9a-f]{7,40}|T-[0-9a-f]{12}|sha256:[0-9a-f]{64})$/;

export const CardRefSchema = z
  .string()
  .regex(CARD_REF_PATTERN, "Card refs must be [file:line], a commit sha, a ticket id, or sha256:<hash>");

const RawCardObjectSchema = z
  .object({
    id: z.string().regex(/^C-[0-9a-f]{12}$/),
    type: CardTypeSchema,
    content: z.string().min(1).max(500),
    refs: z.array(CardRefSchema).min(1).max(20),
    scope: CardScopeSchema,
    /** Folder path (scope=folder) or ticket id (scope=ticket). */
    scopeTarget: z.string().min(1).max(300).optional(),
    replaces: z.string().regex(/^C-[0-9a-f]{12}$/).optional(),
    replacedBy: z.string().regex(/^C-[0-9a-f]{12}$/).optional(),
    createdFrom: z.enum(["explicit", "scan"]).default("explicit"),
    createdAt: z.string().datetime(),
  })
  .strict();

export const CardSchema = z.preprocess((val) => {
  if (val === null || typeof val !== "object" || Array.isArray(val)) return val;
  const raw = val as Record<string, unknown>;
  const out: Record<string, unknown> = { ...raw };
  if ("replaced_by" in out && !("replacedBy" in out)) {
    out["replacedBy"] = out["replaced_by"];
    delete out["replaced_by"];
  }
  if ("created_from" in out && !("createdFrom" in out)) {
    out["createdFrom"] = out["created_from"];
    delete out["created_from"];
  }
  if ("created_at" in out && !("createdAt" in out)) {
    out["createdAt"] = out["created_at"];
    delete out["created_at"];
  }
  if ("scope_target" in out && !("scopeTarget" in out)) {
    out["scopeTarget"] = out["scope_target"];
    delete out["scope_target"];
  }
  return out;
}, RawCardObjectSchema);
export type Card = z.infer<typeof RawCardObjectSchema>;

export const CardsFileSchema = z
  .object({
    version: z.literal(1),
    cards: z.array(CardSchema),
  })
  .strict();
export type CardsFile = z.infer<typeof CardsFileSchema>;

/** Shape used in context packs and portable exports. `hash` lets any consumer verify the card. */
export const PortableCardSchema = z
  .object({
    id: z.string().regex(/^C-[0-9a-f]{12}$/),
    type: CardTypeSchema,
    scope: CardScopeSchema,
    scopeTarget: z.string().min(1).optional(),
    content: z.string().min(1),
    refs: z.array(CardRefSchema).min(1),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type PortableCard = z.infer<typeof PortableCardSchema>;
