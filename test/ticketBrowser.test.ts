import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";
import {
  applyBrowserKey,
  clampBrowserSelection,
  createBrowserState,
  createKeyParser,
  filterBrowserTickets,
  renderBrowser,
} from "../src/cli/ticketBrowser.js";
import { loadTicket, loadTickets } from "../src/engine/tickets.js";
import { markChecklistItem, transitionTicket } from "../src/engine/ticketCommands.js";

function finishTicket(root: string, id: string): void {
  for (const item of loadTicket(root, id)!.checklist) {
    markChecklistItem({ rootDir: root, ticketId: id, item: item.id, evidence: item.ref });
  }
}

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
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

async function createTicketAt(root: string, label: string, file: string): Promise<string> {
  await writeFile(root, file, `export function ${label}(email: string) { return email; }\n`);
  await runCli(["scan", root, "--format", "md", "--quiet"]);
  await runCli(["session", "start", label, "-C", root, "--json"]);
  await writeFile(
    root,
    file,
    `export function ${label}(email: string, password: string) { return email && password; }\n`,
  );
  const capture = captureStdout();
  try {
    await runCli(["session", "end", "-C", root, "--json"]);
  } finally {
    capture.restore();
  }
  const payload = JSON.parse(capture.chunks.join("").trim()) as { ticket: { id: string } };
  return payload.ticket.id;
}

async function createTicket(root: string, label: string): Promise<string> {
  return createTicketAt(root, label, "src/auth/login.ts");
}

describe("ticket browser reducer", () => {
  it("filters inbox, moves, expands, and emits actions", async () => {
    const root = await makeTempDir("memolog-browser-");
    await runCli(["init", root]);
    const first = await createTicket(root, "first");
    const second = await createTicket(root, "second");

    const tickets = loadTickets(root);
    const state = createBrowserState(tickets, "inbox");
    expect(state.tickets).toHaveLength(2);
    expect(state.tickets.map((ticket) => ticket.id)).toContain(first);
    expect(state.tickets.map((ticket) => ticket.id)).toContain(second);

    const moved = applyBrowserKey(state, "down");
    expect(moved.state.selected).toBe(1);

    const expanded = applyBrowserKey(moved.state, "enter");
    expect(expanded.state.expanded).toBe(true);

    const tabbed = applyBrowserKey(expanded.state, "tab");
    expect(tabbed.state.itemCursor).toBe(0);

    const toggled = applyBrowserKey(tabbed.state, "space");
    expect(toggled.action.type).toBe("toggle");

    const accepted = applyBrowserKey(moved.state, "a");
    expect(accepted.action).toMatchObject({ type: "accept" });

    const blocked = applyBrowserKey(moved.state, "b");
    expect(blocked.action).toMatchObject({ type: "block" });

    const quit = applyBrowserKey(moved.state, "q");
    expect(quit.action.type).toBe("quit");

    const help = applyBrowserKey(moved.state, "?");
    expect(help.state.help).toBe(true);
    const closedHelp = applyBrowserKey(help.state, "?");
    expect(closedHelp.state.help).toBe(false);
  });

  it("cycles filters and renders a help overlay", async () => {
    const root = await makeTempDir("memolog-browser-filter-");
    await runCli(["init", root]);
    const id = await createTicket(root, "filter");
    transitionTicket({ rootDir: root, ticketId: id, action: "accept" });
    finishTicket(root, id);
    transitionTicket({ rootDir: root, ticketId: id, action: "done" });

    const all = loadTickets(root);
    expect(filterBrowserTickets(all, "inbox")).toHaveLength(0);
    expect(filterBrowserTickets(all, "done")).toHaveLength(1);

    let state = createBrowserState(all, "inbox");
    for (let index = 0; index < 5; index += 1) {
      state = applyBrowserKey(state, "f").state;
    }
    expect(state.filter).toBe("all");
    expect(state.tickets).toHaveLength(1);

    const help = applyBrowserKey(state, "?").state;
    const rendered = renderBrowser(help);
    expect(rendered).toContain("Keys");
    expect(rendered).toContain("space");
  });

  it("keeps category and limit scope across filter cycling", async () => {
    const root = await makeTempDir("memolog-browser-scope-");
    await runCli(["init", root]);
    const auth = await createTicketAt(root, "authChange", "src/auth/login.ts");
    const utils = await createTicketAt(root, "utilsChange", "src/utils/format.ts");

    const all = loadTickets(root);
    expect(filterBrowserTickets(all, "all", { category: "auth" }).map((ticket) => ticket.id)).toEqual([
      auth,
    ]);
    expect(filterBrowserTickets(all, "all", { category: "utils" }).map((ticket) => ticket.id)).toEqual([
      utils,
    ]);
    expect(filterBrowserTickets(all, "all", { limit: 1 })).toHaveLength(1);
    expect(filterBrowserTickets(all, "all", { limit: 0 })).toHaveLength(0);

    let state = createBrowserState(all, "inbox", { category: "auth", limit: 1 });
    expect(state.scope).toEqual({ category: "auth", limit: 1 });
    for (let index = 0; index < 5; index += 1) {
      state = applyBrowserKey(state, "f").state;
    }
    expect(state.filter).toBe("all");
    expect(state.tickets.map((ticket) => ticket.id)).toEqual([auth]);
  });

  it("parses split and unknown terminal escape sequences", () => {
    const parser = createKeyParser();

    // An arrow key split across two reads must not be mistaken for Escape.
    expect(parser.feed("\u001b")).toEqual([]);
    expect(parser.hasPending()).toBe(true);
    expect(parser.feed("[B")).toEqual(["down"]);
    expect(parser.hasPending()).toBe(false);

    // Unknown CSI sequences (e.g. Ctrl-Right) are ignored, not emitted as text.
    expect(parser.feed("\u001b[1;5C")).toEqual([]);
    // Unknown SS3 sequence (F1) is ignored too.
    expect(parser.feed("\u001bOP")).toEqual([]);
    // Shift-Tab still maps to the item cursor.
    expect(parser.feed("\u001b[Z")).toEqual(["tab"]);

    // A genuinely lone Escape is resolved by flush() after the timeout.
    expect(parser.feed("\u001b")).toEqual([]);
    expect(parser.flush()).toEqual(["escape"]);

    // Control characters map to the browser's key names.
    expect(parser.feed("\u0003")).toEqual(["q"]);
    expect(parser.feed("\r")).toEqual(["enter"]);
  });

  it("clamps the selection when the visible list shrinks", async () => {
    const root = await makeTempDir("memolog-browser-clamp-");
    await runCli(["init", root]);
    await createTicket(root, "clampFirst");
    await createTicket(root, "clampSecond");

    const state = createBrowserState(loadTickets(root), "inbox");
    expect(state.tickets).toHaveLength(2);
    const onLast = { ...state, selected: 1 };
    expect(clampBrowserSelection(onLast).selected).toBe(1);

    const oneLeft = clampBrowserSelection({ ...onLast, tickets: [state.tickets[0]!] });
    expect(oneLeft.selected).toBe(0);

    const noneLeft = clampBrowserSelection({ ...onLast, tickets: [] });
    expect(noneLeft.selected).toBe(0);

    // Already-valid state is returned unchanged (no needless allocation).
    expect(clampBrowserSelection(state)).toBe(state);
  });
});
