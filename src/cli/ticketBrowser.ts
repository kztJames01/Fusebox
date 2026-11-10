// Pure keyboard-navigation state retained for ticket-browser compatibility.
//
// The reducer contains no I/O, so the key map, filtering, and rendering can be
// tested without a TTY. The CLI loop owns raw mode and executes the returned
// actions.
import type { Category } from "../types/categories.js";
import type { Ticket, TicketState } from "../types/ticket.js";

export type BrowserFilter = "inbox" | TicketState | "all";

/**
 * Non-state filters that apply to every view and must survive filter cycling.
 */
export interface BrowserScope {
  category?: Category | undefined;
  limit?: number | undefined;
  view?: "list" | "board" | undefined;
}

export const BROWSER_FILTERS: readonly BrowserFilter[] = [
  "inbox",
  "open",
  "needs_review",
  "done",
  "blocked",
  "all",
];

export interface BrowserState {
  allTickets: Ticket[];
  tickets: Ticket[];
  selected: number;
  expanded: boolean;
  itemCursor: number;
  filter: BrowserFilter;
  scope: BrowserScope;
  view: "list" | "board";
  help: boolean;
  message?: string | undefined;
}

export type BrowserAction =
  | { type: "quit" }
  | { type: "accept"; ticketId: string }
  | { type: "done"; ticketId: string }
  | { type: "block"; ticketId: string }
  | { type: "reopen"; ticketId: string }
  | { type: "toggle"; ticketId: string; itemId: string }
  | { type: "none" };

export interface BrowserKeyResult {
  state: BrowserState;
  action: BrowserAction;
}

export function filterBrowserTickets(
  tickets: readonly Ticket[],
  filter: BrowserFilter,
  scope: BrowserScope = {},
): Ticket[] {
  const matchesState = (ticket: Ticket): boolean => {
    if (filter === "all") {
      return true;
    }
    if (filter === "inbox") {
      return ticket.state === "open" || ticket.state === "needs_review";
    }
    return ticket.state === filter;
  };

  const matchesCategory = (ticket: Ticket): boolean =>
    scope.category === undefined ||
    ticket.changes.some((change) => change.category === scope.category);

  const filtered = tickets
    .filter((ticket) => matchesState(ticket) && matchesCategory(ticket))
    .sort((a, b) => {
      const byCreated = b.createdAt.localeCompare(a.createdAt);
      return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id);
    });

  if (scope.limit === undefined) {
    return filtered;
  }
  return filtered.slice(0, Math.max(0, Math.trunc(scope.limit)));
}

export function createBrowserState(
  tickets: readonly Ticket[],
  filter: BrowserFilter = "inbox",
  scope: BrowserScope = {},
): BrowserState {
  return {
    allTickets: [...tickets],
    tickets: filterBrowserTickets(tickets, filter, scope),
    selected: 0,
    expanded: false,
    itemCursor: 0,
    filter,
    scope,
    view: scope.view ?? "list",
    help: false,
  };
}

export function selectedTicket(state: BrowserState): Ticket | undefined {
  return state.tickets[state.selected];
}

function clampSelection(state: BrowserState, index: number): number {
  if (state.tickets.length === 0) {
    return 0;
  }
  return Math.max(0, Math.min(index, state.tickets.length - 1));
}

function withFilter(state: BrowserState, filter: BrowserFilter): BrowserState {
  return {
    ...state,
    tickets: filterBrowserTickets(state.allTickets, filter, state.scope),
    filter,
    selected: 0,
    expanded: false,
    itemCursor: 0,
    message: undefined,
  };
}

/**
 * Keep the cursor inside the visible list after a transition removes or
 * reorders the selected ticket. Without this, `selected` can point past the end
 * and the browser silently loses its selection.
 */
export function clampBrowserSelection(state: BrowserState): BrowserState {
  const selected = state.tickets.length === 0
    ? 0
    : Math.min(state.selected, state.tickets.length - 1);
  return selected === state.selected ? state : { ...state, selected };
}

export function applyBrowserKey(state: BrowserState, key: string): BrowserKeyResult {
  if (state.help) {
    return {
      state: { ...state, help: false },
      action: { type: "none" },
    };
  }

  if (key === "q" || key === "Q" || key === "escape") {
    return { state, action: { type: "quit" } };
  }

  if (key === "?") {
    return { state: { ...state, help: true }, action: { type: "none" } };
  }

  if (key === "f") {
    const index = BROWSER_FILTERS.indexOf(state.filter);
    const next = BROWSER_FILTERS[(index + 1) % BROWSER_FILTERS.length] ?? "inbox";
    return { state: withFilter(state, next), action: { type: "none" } };
  }

  if (key === "v") {
    return {
      state: { ...state, view: state.view === "board" ? "list" : "board" },
      action: { type: "none" },
    };
  }

  if (key === "up" || key === "k") {
    return {
      state: {
        ...state,
        selected: clampSelection(state, state.selected - 1),
        expanded: false,
        itemCursor: 0,
      },
      action: { type: "none" },
    };
  }

  if (key === "down" || key === "j") {
    return {
      state: {
        ...state,
        selected: clampSelection(state, state.selected + 1),
        expanded: false,
        itemCursor: 0,
      },
      action: { type: "none" },
    };
  }

  if (key === "enter") {
    return {
      state: { ...state, expanded: !state.expanded, itemCursor: 0 },
      action: { type: "none" },
    };
  }

  const ticket = selectedTicket(state);
  if (!ticket) {
    return { state, action: { type: "none" } };
  }

  if (key === "tab" && state.expanded && ticket.checklist.length > 0) {
    return {
      state: {
        ...state,
        itemCursor: (state.itemCursor + 1) % ticket.checklist.length,
      },
      action: { type: "none" },
    };
  }

  if (key === "space" && state.expanded) {
    const item = ticket.checklist[state.itemCursor];
    if (!item) {
      return { state, action: { type: "none" } };
    }
    return {
      state,
      action: { type: "toggle", ticketId: ticket.id, itemId: item.id },
    };
  }

  if (key === "a") {
    return { state, action: { type: "accept", ticketId: ticket.id } };
  }
  if (key === "d") {
    return { state, action: { type: "done", ticketId: ticket.id } };
  }
  if (key === "b") {
    return { state, action: { type: "block", ticketId: ticket.id } };
  }
  if (key === "r") {
    return { state, action: { type: "reopen", ticketId: ticket.id } };
  }

  return { state, action: { type: "none" } };
}

const FILTER_LABEL: Record<BrowserFilter, string> = {
  inbox: "inbox (open + needs review)",
  open: "open",
  needs_review: "needs review",
  done: "done",
  blocked: "blocked",
  superseded: "superseded",
  all: "all",
};

const BOARD_COLUMNS: ReadonlyArray<{ state: TicketState; label: string }> = [
  { state: "open", label: "Open" },
  { state: "needs_review", label: "In review" },
  { state: "blocked", label: "Blocked" },
  { state: "done", label: "Done" },
  { state: "superseded", label: "Superseded" },
];

export function renderBoardColumns(
  tickets: readonly Ticket[],
  selectedId?: string | undefined,
): string[] {
  const lines: string[] = [];
  for (const col of BOARD_COLUMNS) {
    const group = tickets.filter((ticket) => ticket.state === col.state);
    lines.push(`## ${col.label} (${group.length})`);
    if (group.length === 0) {
      lines.push("  (empty)");
    } else {
      for (const ticket of group) {
        const marker = ticket.id === selectedId ? ">" : " ";
        const done = ticket.checklist.filter((item) => item.status === "done").length;
        const blocked = ticket.blockedReason !== undefined ? ` — blocked: ${ticket.blockedReason}` : "";
        lines.push(
          `${marker} ${ticket.id} ${ticket.title} (${done}/${ticket.checklist.length} checked)${blocked}`,
        );
      }
    }
    lines.push("");
  }
  return lines;
}

export function renderBrowser(state: BrowserState, options: { color?: boolean } = {}): string {
  const lines: string[] = [];
  const dim = (value: string): string => (options.color === true ? `\x1b[2m${value}\x1b[0m` : value);
  const bold = (value: string): string => (options.color === true ? `\x1b[1m${value}\x1b[0m` : value);

  const viewSuffix = state.view === "board" ? " · board view" : "";
  lines.push(bold(`memo-log tickets — ${FILTER_LABEL[state.filter]}${viewSuffix}`));
  lines.push(dim("↑/↓ move · enter expand · tab item · space toggle · a accept · d done · b block · r reopen · f filter · ? help · q quit"));
  lines.push("");

  if (state.tickets.length === 0) {
    lines.push("No tickets match this filter.");
  }

  state.tickets.forEach((ticket, index) => {
    const marker = index === state.selected ? ">" : " ";
    const done = ticket.checklist.filter((item) => item.status === "done").length;
    const blocked = ticket.blockedReason !== undefined ? ` — blocked: ${ticket.blockedReason}` : "";
    lines.push(
      `${marker} ${ticket.id} [${ticket.state}] ${ticket.title} (${done}/${ticket.checklist.length} checked)${blocked}`,
    );

    if (index === state.selected && state.expanded) {
      for (const change of ticket.changes) {
        lines.push(`    · ${change.changeType} ${change.path} (${change.category})`);
      }
      ticket.checklist.forEach((item, itemIndex) => {
        const cursor = itemIndex === state.itemCursor ? ">" : " ";
        const box = item.status === "done" ? "[x]" : "[ ]";
        lines.push(`  ${cursor} ${box} ${item.text} ${item.ref}`);
      });
    }
  });

  if (state.message !== undefined) {
    lines.push("", state.message);
  }

  if (state.help) {
    lines.push(
      "",
      bold("Keys"),
      "  ↑/k, ↓/j     move between tickets",
      "  enter        expand or collapse the selected ticket",
      "  tab          move between checklist items",
      "  space        toggle the selected checklist item",
      "  a            accept: open → needs review",
      "  d            mark done",
      "  b            block (prompts for a reason)",
      "  r            reopen a blocked or done ticket",
      "  f            cycle state filter",
      "  ?            toggle this help",
      "  q / esc      quit",
    );
  }

  return lines.join("\n");
}

/**
 * Incremental terminal key parser.
 *
 * Escape sequences can be split across `data` chunks, so a stateless parser
 * cannot tell `ESC [ A` (Up) from a lone `ESC` (quit). This parser buffers an
 * incomplete sequence until the final byte arrives, ignores unknown CSI
 * sequences (e.g. Shift-Tab), and exposes `flush()` so the caller can resolve a
 * genuinely lone Escape after a short timeout.
 */
export interface KeyParser {
  feed(chunk: string): string[];
  flush(): string[];
  hasPending(): boolean;
}

const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;

function mapEscapeSequence(sequence: string): string | undefined {
  switch (sequence) {
    case "\u001b[A":
    case "\u001bOA":
      return "up";
    case "\u001b[B":
    case "\u001bOB":
      return "down";
    case "\u001b[C":
    case "\u001bOC":
      return "right";
    case "\u001b[D":
    case "\u001bOD":
      return "left";
    case "\u001b[Z":
      return "tab";
    default:
      return undefined;
  }
}

export function createKeyParser(): KeyParser {
  let buffer = "";

  const decode = (final: boolean): string[] => {
    const keys: string[] = [];

    while (buffer.length > 0) {
      const character = buffer[0] ?? "";

      if (character === "\u001b") {
        if (buffer.length === 1) {
          if (!final) {
            break;
          }
          buffer = "";
          keys.push("escape");
          break;
        }

        const second = buffer[1] ?? "";
        if (second === "[" || second === "O") {
          let end = -1;
          for (let index = 2; index < buffer.length; index += 1) {
            const code = buffer.charCodeAt(index);
            if (code >= CSI_FINAL_MIN && code <= CSI_FINAL_MAX) {
              end = index;
              break;
            }
          }
          if (end === -1) {
            // Incomplete sequence: wait for the next chunk, or drop it when the
            // stream is closing so a truncated sequence cannot hang the loop.
            if (final) {
              buffer = "";
            }
            break;
          }
          const sequence = buffer.slice(0, end + 1);
          buffer = buffer.slice(end + 1);
          const mapped = mapEscapeSequence(sequence);
          if (mapped !== undefined) {
            keys.push(mapped);
          }
          continue;
        }

        // ESC followed by a regular character: emit Escape and process the
        // next character normally.
        buffer = buffer.slice(1);
        keys.push("escape");
        continue;
      }

      buffer = buffer.slice(1);
      if (character === "\r" || character === "\n") {
        keys.push("enter");
      } else if (character === "\t") {
        keys.push("tab");
      } else if (character === " ") {
        keys.push("space");
      } else if (character === "\u0003") {
        keys.push("q");
      } else {
        keys.push(character);
      }
    }

    return keys;
  };

  return {
    feed(chunk: string): string[] {
      buffer += chunk;
      return decode(false);
    },
    flush(): string[] {
      return decode(true);
    },
    hasPending(): boolean {
      return buffer.length > 0;
    },
  };
}
