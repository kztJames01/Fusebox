import { describe, expect, it } from "vitest";

import {
  EMPTY_REVIEW_FILTERS,
  buildBoardModel,
  buildInboxModel,
  filterReviewTickets,
  reviewCounts,
  reviewPriorityOf,
  sortReviewTickets,
  toReviewTicketSummary,
} from "../src/engine/reviewModel.js";
import type { Ticket, TicketState } from "../src/types/ticket.js";

function ticket(
  id: string,
  state: TicketState,
  overrides: Partial<Ticket> = {},
): Ticket {
  return {
    schemaVersion: 1,
    id,
    title: `${state} ticket ${id}`,
    state,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    summary: `summary for ${id}`,
    impactScore: 0.5,
    changes: [
      {
        path: "src/auth/login.ts",
        changeType: "MODIFIED",
        category: "auth",
        exportsAdded: [],
        exportsRemoved: [],
        signaturesChanged: [],
        impactScore: 0.5,
      },
    ],
    groups: [],
    checklist: [
      {
        id: "C-aaaaaaaaaaaa",
        rule: "file_modified",
        text: "File was modified.",
        ref: "[src/auth/login.ts:1]",
        status: "pending",
        verified: true,
      },
    ],
    artifacts: [],
    stateHistory: [],
    ...overrides,
  };
}

const ids = ["T-000000000001", "T-000000000002", "T-000000000003", "T-000000000004"] as const;

describe("review model", () => {
  it("keeps the inbox scoped to work that still needs attention", () => {
    const tickets = [
      ticket(ids[0], "open"),
      ticket(ids[1], "needs_review"),
      ticket(ids[2], "blocked"),
      ticket(ids[3], "done"),
    ];

    const inbox = buildInboxModel(tickets);
    expect(inbox.kind).toBe("memo-log-mcp-inbox");
    expect(inbox.view).toBe("inbox");
    expect(inbox.total).toBe(3);
    expect(inbox.visible).toBe(3);
    expect(inbox.tickets.map((row) => row.id)).not.toContain(ids[3]);
    expect(inbox.groups.map((group) => group.state)).toEqual([
      "needs_review",
      "open",
      "blocked",
    ]);
    expect(inbox.needsReview).toBe(2);
    expect(inbox.counts).toEqual({ open: 1, needs_review: 1, blocked: 1, done: 1 });
  });

  it("always renders four board columns even when a column is empty", () => {
    const board = buildBoardModel([ticket(ids[0], "open")]);
    expect(board.kind).toBe("memo-log-mcp-board");
    expect(board.columns.map((column) => column.state)).toEqual([
      "open",
      "needs_review",
      "blocked",
      "done",
    ]);
    expect(board.columns.map((column) => column.count)).toEqual([1, 0, 0, 0]);
    expect(board.columns[3]?.tickets).toEqual([]);
  });

  it("is deterministic and filters without inventing data", () => {
    const older = ticket(ids[0], "open", { updatedAt: "2026-10-01T00:00:00.000Z" });
    const newer = ticket(ids[1], "open", { updatedAt: "2026-11-01T00:00:00.000Z" });
    const sorted = sortReviewTickets([older, newer]);
    expect(sorted.map((row) => row.id)).toEqual([ids[1], ids[0]]);

    expect(filterReviewTickets(sorted, EMPTY_REVIEW_FILTERS)).toHaveLength(2);
    expect(
      filterReviewTickets(sorted, { q: "login", priority: "", category: "" }),
    ).toHaveLength(2);
    expect(
      filterReviewTickets(sorted, { q: "", priority: "high", category: "" }),
    ).toHaveLength(2);
    expect(
      filterReviewTickets(sorted, { q: "", priority: "urgent", category: "" }),
    ).toHaveLength(0);
    expect(
      filterReviewTickets(sorted, { q: "", priority: "", category: "billing" }),
    ).toHaveLength(0);
  });

  it("summarizes tickets with references but no checklist bodies", () => {
    const source = ticket(ids[0], "open", {
      label: "auth",
      sessionId: "S-0123456789ab",
      impactScore: 0.8,
      artifacts: [{ kind: "commit", sha: "abcdef1" }],
    });
    const summary = toReviewTicketSummary(source);
    expect(summary.priority).toBe("urgent");
    expect(summary.categories).toEqual(["auth"]);
    expect(summary.primaryRef).toBe("src/auth/login.ts:1");
    expect(summary.checklist).toEqual({ done: 0, total: 1, pending: 1 });
    expect(summary.commitCount).toBe(1);
    expect(JSON.stringify(summary)).not.toContain("File was modified");
  });

  it("maps impact to stable priority buckets", () => {
    expect(reviewPriorityOf(ticket(ids[0], "open", { impactScore: 0.9 }))).toBe("urgent");
    expect(reviewPriorityOf(ticket(ids[0], "open", { impactScore: 0.6 }))).toBe("high");
    expect(reviewPriorityOf(ticket(ids[0], "open", { impactScore: 0.3 }))).toBe("medium");
    expect(reviewPriorityOf(ticket(ids[0], "open", { impactScore: 0.1 }))).toBe("low");
    expect(reviewCounts([])).toEqual({ open: 0, needs_review: 0, blocked: 0, done: 0 });
  });
});
