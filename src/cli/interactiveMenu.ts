// Keyboard menu for `memo-log` with no arguments.
//
// The reducer is pure. The loop owns the TTY, calls the same engine functions
// as the subcommands, and prints the exact command string before and after
// each action. UI prefs never change scan or ticket bytes.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadEffectiveConfig } from "../engine/config.js";
import { buildQueryPayload } from "../engine/contextQuery.js";
import { CliError } from "../engine/errors.js";
import { runSessionEnd, runSessionStart, runSessionStatus } from "../engine/sessionCommands.js";
import { attributionStatus } from "../engine/attribution.js";
import {
  renderGithubExport,
  writeGithubExport,
  writeMarkdownExport,
} from "../engine/ticketExport.js";
import { createKeyParser } from "./ticketBrowser.js";
import { parseCategoryFilter, parseFileFilter, renderQuery } from "./query.js";
import { renderCompact, runCompact } from "./compact.js";
import {
  loadSessionPrefs,
  saveSessionPrefs,
  type SessionPrefs,
} from "./sessionPrefs.js";

export type MenuName = "root" | "session" | "query" | "export";

export interface MenuItem {
  id: string;
  label: string;
  command: string;
}

export const ROOT_MENU: readonly MenuItem[] = [
  {
    id: "session",
    label: "Start/continue session",
    command: "memo-log session start | memo-log session status | memo-log session end",
  },
  {
    id: "tickets",
    label: "Review tickets",
    command: "memo-log review",
  },
  {
    id: "query",
    label: "Query context",
    command: "memo-log query --category <category> | memo-log query --structural --file <path>",
  },
  {
    id: "compact",
    label: "Compact",
    command: "memo-log compact --dry-run",
  },
  {
    id: "export",
    label: "Export",
    command: "memo-log export markdown | memo-log export github",
  },
  {
    id: "conflicts",
    label: "View conflicts",
    command: "memo-log scan --agent-ui",
  },
  {
    id: "settings",
    label: "Settings",
    command: "read .memolog.json",
  },
];

export const SESSION_MENU: readonly MenuItem[] = [
  { id: "session-start", label: "Start session", command: "memo-log session start <label>" },
  { id: "session-status", label: "Session status", command: "memo-log session status" },
  { id: "session-attribution", label: "Attribution status", command: "memo-log session attribution" },
  { id: "session-end", label: "End session", command: "memo-log session end" },
];

export const QUERY_MENU: readonly MenuItem[] = [
  { id: "query-category", label: "Query by category", command: "memo-log query --category <category>" },
  { id: "query-file", label: "Query by file", command: "memo-log query --structural --file <path>" },
];

export const EXPORT_MENU: readonly MenuItem[] = [
  { id: "export-markdown", label: "Export markdown", command: "memo-log export markdown" },
  { id: "export-github", label: "Export GitHub drafts", command: "memo-log export github" },
];

export type PendingAction =
  | { type: "session-status" }
  | { type: "session-attribution" }
  | { type: "session-end" }
  | { type: "session-start"; label: string }
  | { type: "query-category"; category: string }
  | { type: "query-file"; file: string }
  | { type: "compact-dry" }
  | { type: "compact-apply" }
  | { type: "export-markdown" }
  | { type: "export-github" }
  | { type: "conflicts" }
  | { type: "settings" }
  | { type: "review" };

export type PromptKind = "session-label" | "query-category" | "query-file";

export interface InteractiveState {
  menu: MenuName;
  selected: number;
  help: boolean;
  prompt: { kind: PromptKind; value: string } | null;
  pending: PendingAction | null;
  result: { command: string; body: string; offerCompact: boolean } | null;
  filter: string;
  message?: string | undefined;
}

export type MenuEffect =
  | { type: "none" }
  | { type: "quit" }
  | { type: "execute"; action: PendingAction }
  | { type: "open-review" };

export interface MenuKeyResult {
  state: InteractiveState;
  effect: MenuEffect;
}

export function menuItems(menu: MenuName): readonly MenuItem[] {
  switch (menu) {
    case "session":
      return SESSION_MENU;
    case "query":
      return QUERY_MENU;
    case "export":
      return EXPORT_MENU;
    default:
      return ROOT_MENU;
  }
}

export function quoteArg(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

export function commandFor(action: PendingAction): string {
  switch (action.type) {
    case "session-status":
      return "memo-log session status";
    case "session-attribution":
      return "memo-log session attribution";
    case "session-end":
      return "memo-log session end";
    case "session-start":
      return action.label.length > 0
        ? `memo-log session start ${quoteArg(action.label)}`
        : "memo-log session start";
    case "query-category":
      return `memo-log query --category ${quoteArg(action.category)}`;
    case "query-file":
      return `memo-log query --structural --file ${quoteArg(action.file)}`;
    case "compact-dry":
      return "memo-log compact --dry-run";
    case "compact-apply":
      return "memo-log compact";
    case "export-markdown":
      return "memo-log export markdown";
    case "export-github":
      return "memo-log export github";
    case "conflicts":
      return "memo-log scan --agent-ui";
    case "settings":
      return "read .memolog.json";
    case "review":
      return "memo-log review";
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

export function createInteractiveState(prefs: SessionPrefs = { schema: 1 }): InteractiveState {
  const lastMenu = prefs.lastMenu ?? "session";
  const index = ROOT_MENU.findIndex((item) => item.id === lastMenu);
  return {
    menu: "root",
    selected: index >= 0 ? index : 0,
    help: false,
    prompt: null,
    pending: null,
    result: null,
    filter: prefs.filter ?? "",
  };
}

export function prefsFromState(state: InteractiveState): SessionPrefs {
  const lastMenu = state.menu === "root"
    ? ROOT_MENU[state.selected]?.id ?? "session"
    : state.menu;
  return {
    schema: 1,
    lastMenu,
    ...(state.filter.length > 0 ? { filter: state.filter } : {}),
  };
}

function clamp(index: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(index, length - 1));
}

function withMessage(state: InteractiveState, message: string): InteractiveState {
  return { ...state, message };
}

function activateItem(state: InteractiveState, item: MenuItem): MenuKeyResult {
  switch (item.id) {
    case "session":
      return {
        state: { ...state, menu: "session", selected: 0, message: undefined },
        effect: { type: "none" },
      };
    case "query":
      return {
        state: { ...state, menu: "query", selected: 0, message: undefined },
        effect: { type: "none" },
      };
    case "export":
      return {
        state: { ...state, menu: "export", selected: 0, message: undefined },
        effect: { type: "none" },
      };
    case "tickets":
      return {
        state: { ...state, pending: { type: "review" }, result: null, message: undefined },
        effect: { type: "none" },
      };
    case "compact":
      return {
        state: { ...state, pending: { type: "compact-dry" }, result: null, message: undefined },
        effect: { type: "none" },
      };
    case "conflicts":
      return {
        state: { ...state, pending: { type: "conflicts" }, result: null, message: undefined },
        effect: { type: "none" },
      };
    case "settings":
      return {
        state: { ...state, pending: { type: "settings" }, result: null, message: undefined },
        effect: { type: "none" },
      };
    case "session-status":
      return {
        state: { ...state, pending: { type: "session-status" }, result: null, message: undefined },
        effect: { type: "none" },
      };
    case "session-attribution":
      return {
        state: { ...state, pending: { type: "session-attribution" }, result: null, message: undefined },
        effect: { type: "none" },
      };
    case "session-end":
      return {
        state: { ...state, pending: { type: "session-end" }, result: null, message: undefined },
        effect: { type: "none" },
      };
    case "session-start":
      return {
        state: {
          ...state,
          prompt: { kind: "session-label", value: "" },
          pending: null,
          result: null,
          message: undefined,
        },
        effect: { type: "none" },
      };
    case "query-category":
      return {
        state: {
          ...state,
          prompt: { kind: "query-category", value: state.filter },
          pending: null,
          result: null,
          message: undefined,
        },
        effect: { type: "none" },
      };
    case "query-file":
      return {
        state: {
          ...state,
          prompt: { kind: "query-file", value: state.filter },
          pending: null,
          result: null,
          message: undefined,
        },
        effect: { type: "none" },
      };
    case "export-markdown":
      return {
        state: { ...state, pending: { type: "export-markdown" }, result: null, message: undefined },
        effect: { type: "none" },
      };
    case "export-github":
      return {
        state: { ...state, pending: { type: "export-github" }, result: null, message: undefined },
        effect: { type: "none" },
      };
    default:
      return { state, effect: { type: "none" } };
  }
}

function submitPrompt(state: InteractiveState): MenuKeyResult {
  const prompt = state.prompt;
  if (!prompt) {
    return { state, effect: { type: "none" } };
  }
  const value = prompt.value.trim();
  if (prompt.kind === "session-label") {
    return {
      state: {
        ...state,
        prompt: null,
        pending: { type: "session-start", label: value },
        message: undefined,
      },
      effect: { type: "none" },
    };
  }
  if (value.length === 0) {
    return {
      state: withMessage(state, "Enter a value, or press esc to cancel."),
      effect: { type: "none" },
    };
  }
  if (prompt.kind === "query-category") {
    try {
      parseCategoryFilter(value);
    } catch (error) {
      return {
        state: withMessage(state, error instanceof Error ? error.message : String(error)),
        effect: { type: "none" },
      };
    }
    return {
      state: {
        ...state,
        prompt: null,
        filter: value,
        pending: { type: "query-category", category: value },
        message: undefined,
      },
      effect: { type: "none" },
    };
  }
  try {
    parseFileFilter(value);
  } catch (error) {
    return {
      state: withMessage(state, error instanceof Error ? error.message : String(error)),
      effect: { type: "none" },
    };
  }
  return {
    state: {
      ...state,
      prompt: null,
      filter: value,
      pending: { type: "query-file", file: value },
      message: undefined,
    },
    effect: { type: "none" },
  };
}

function goBack(state: InteractiveState): MenuKeyResult {
  if (state.help) {
    return { state: { ...state, help: false }, effect: { type: "none" } };
  }
  if (state.prompt) {
    return { state: { ...state, prompt: null, message: undefined }, effect: { type: "none" } };
  }
  if (state.pending) {
    return { state: { ...state, pending: null, message: undefined }, effect: { type: "none" } };
  }
  if (state.result) {
    return { state: { ...state, result: null, message: undefined }, effect: { type: "none" } };
  }
  if (state.menu !== "root") {
    const parentIndex = ROOT_MENU.findIndex((item) => item.id === state.menu);
    return {
      state: {
        ...state,
        menu: "root",
        selected: parentIndex >= 0 ? parentIndex : 0,
        message: undefined,
      },
      effect: { type: "none" },
    };
  }
  return { state, effect: { type: "quit" } };
}

export function applyMenuKey(state: InteractiveState, key: string): MenuKeyResult {
  if ((key === "q" || key === "Q") && !state.prompt) {
    return { state, effect: { type: "quit" } };
  }

  if (state.help) {
    return { state: { ...state, help: false }, effect: { type: "none" } };
  }

  if (key === "escape") {
    return goBack(state);
  }

  if (key === "?" && !state.prompt) {
    return { state: { ...state, help: true }, effect: { type: "none" } };
  }

  if (state.prompt) {
    if (key === "enter") {
      return submitPrompt(state);
    }
    if (key === "backspace" || key === "\u007f" || key === "\b") {
      return {
        state: {
          ...state,
          prompt: { ...state.prompt, value: state.prompt.value.slice(0, -1) },
          message: undefined,
        },
        effect: { type: "none" },
      };
    }
    if (key.length === 1 && key >= " " && key !== "\u001b") {
      return {
        state: {
          ...state,
          prompt: { ...state.prompt, value: state.prompt.value + key },
          message: undefined,
        },
        effect: { type: "none" },
      };
    }
    return { state, effect: { type: "none" } };
  }

  if (state.result?.offerCompact && (key === "y" || key === "Y")) {
    return {
      state: {
        ...state,
        result: null,
        pending: { type: "compact-apply" },
        message: undefined,
      },
      effect: { type: "none" },
    };
  }

  if (state.result) {
    if (key === "enter") {
      return { state: { ...state, result: null }, effect: { type: "none" } };
    }
    return { state, effect: { type: "none" } };
  }

  if (state.pending) {
    if (key === "enter") {
      if (state.pending.type === "review") {
        return {
          state: { ...state, pending: null },
          effect: { type: "open-review" },
        };
      }
      return {
        state,
        effect: { type: "execute", action: state.pending },
      };
    }
    return { state, effect: { type: "none" } };
  }

  const items = menuItems(state.menu);
  const digit = /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
  if (digit >= 0 && digit < items.length) {
    const selected = { ...state, selected: digit };
    const item = items[digit];
    return item ? activateItem(selected, item) : { state: selected, effect: { type: "none" } };
  }

  if (key === "up" || key === "k" || key === "down" || key === "j") {
    const next = clamp(state.selected + (key === "down" || key === "j" ? 1 : -1), items.length);
    if (next === state.selected) {
      return { state, effect: { type: "none" } };
    }
    return {
      state: { ...state, selected: next, message: undefined },
      effect: { type: "none" },
    };
  }
  if (key === "enter") {
    const item = items[state.selected];
    return item ? activateItem(state, item) : { state, effect: { type: "none" } };
  }

  return { state, effect: { type: "none" } };
}

const INK = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  text: "\x1b[38;2;238;233;220m",
  muted: "\x1b[38;2;180;178;165m",
  faint: "\x1b[38;2;137;141;127m",
  accent: "\x1b[38;2;183;243;107m",
  orange: "\x1b[38;2;255;112;67m",
} as const;

function inkOn(): boolean {
  return process.env["NO_COLOR"] === undefined && process.env["TERM"] !== "dumb";
}

function ink(codes: string, value: string): string {
  return inkOn() ? `${codes}${value}${INK.reset}` : value;
}

function wordmark(): string {
  return `${ink(INK.bold + INK.text, "memo")}${ink(INK.bold + INK.accent, "-log")}`;
}

function hint(key: string, label: string): string {
  return `${ink(INK.accent, key)} ${ink(INK.faint, label)}`;
}

function hints(pairs: ReadonlyArray<readonly [string, string]>): string {
  return pairs.map(([key, label]) => hint(key, label)).join("   ");
}

function helpLines(): string[] {
  return [
    "Keys",
    "  ↑/k  ↓/j     move",
    "  1-9          choose that item",
    "  enter        open or run the highlighted command",
    "  esc          back (quit from the root menu)",
    "  q            quit",
    "  ?            this help",
    "  y            after a compact dry-run, review memo-log compact",
    "",
    "Commands",
    "  memo-log session start [label]",
    "  memo-log session status",
    "  memo-log session end",
    "  memo-log review",
    "  memo-log query --category <category>",
    "  memo-log query --structural --file <path>",
    "  memo-log compact --dry-run",
    "  memo-log compact",
    "  memo-log export markdown",
    "  memo-log export github",
    "  memo-log scan --agent-ui",
  ];
}

export function renderMenu(state: InteractiveState): string {
  const lines: string[] = [wordmark()];

  if (state.prompt) {
    const label = state.prompt.kind === "session-label"
      ? "Session label (empty starts an unlabeled session)"
      : state.prompt.kind === "query-category"
        ? "Category"
        : "Relative file path";
    lines.push(
      ink(INK.muted, label),
      "",
      `${ink(INK.accent, "┃")} ${ink(INK.text, state.prompt.value)}${ink(INK.accent, "▌")}`,
      "",
      hints([["enter", "confirm"], ["esc", "cancel"]]),
    );
  } else if (state.pending) {
    lines.push(
      "",
      ink(INK.faint, "Will run:"),
      `${ink(INK.accent, "┃")} ${ink(INK.text, commandFor(state.pending))}`,
      "",
      hints([["enter", "run"], ["esc", "cancel"]]),
    );
  } else if (state.result) {
    lines.push(ink(INK.faint, "RESULT"), "", ink(INK.text, `Ran: ${state.result.command}`), "", state.result.body);
    if (state.result.body.trim().length === 0) {
      lines.push("No output.");
    }
    if (state.result.offerCompact) {
      lines.push("", ink(INK.muted, "Dry-run only. Press y to review memo-log compact, then enter to apply it."));
    }
    lines.push("", hints([["esc", "back"]]));
  } else {
    const items = menuItems(state.menu);
    const kicker = state.menu === "root" ? "field manual" : state.menu;
    lines.push(ink(INK.faint, kicker.toUpperCase()), "");
    items.forEach((item, index) => {
      const selected = index === state.selected;
      const bar = ink(selected ? INK.accent : INK.faint, selected ? "┃" : "│");
      const number = ink(selected ? INK.accent : INK.faint, String(index + 1));
      const label = ink(selected ? INK.bold + INK.text : INK.muted, item.label);
      lines.push(`${bar} ${number}  ${label}`);
    });
    if (items.length === 0) {
      lines.push(ink(INK.muted, "Nothing to show."));
    }
    const current = items[state.selected];
    lines.push(
      "",
      ink(INK.faint, current?.command ?? ""),
      "",
      hints([["↑↓", "move"], ["enter", "open"], ["1-9", "jump"], ["?", "help"], ["q", "quit"]]),
    );
  }

  if (state.message !== undefined) {
    lines.push("", ink(INK.orange, state.message));
  }
  if (state.help) {
    lines.push("", ...helpLines().map((line) => ink(INK.muted, line)));
  }
  return lines.join("\n");
}

export function renderCompactHelp(): string {
  return [
    "memo-log — local MCP server and interactive CLI for reference-anchored tickets.",
    "",
    "  npx memo-log                 keyboard menu when stdin is a TTY",
    "  memo-log review              open the local review page",
    "  memo-log mcp -C <dir>        MCP server over stdio",
    "  memo-log scan [dir]          generate MEMO_LOG for CI and scripts",
    "",
    "  memo-log --help              every command",
  ].join("\n");
}

export type MenuInput = NodeJS.ReadableStream & {
  isTTY?: boolean | undefined;
  setRawMode?: ((mode: boolean) => void) | undefined;
  setEncoding?: ((encoding: BufferEncoding) => void) | undefined;
  resume?: (() => void) | undefined;
  pause?: (() => void) | undefined;
};

export interface InteractiveMenuOptions {
  rootDir: string;
  input?: MenuInput | undefined;
  output?: NodeJS.WritableStream | undefined;
  /** Test hook: replace the long-running local review server. */
  openReview?: ((rootDir: string) => Promise<number>) | undefined;
}

const ENTER_SCREEN = "\u001b[?1049h";
const LEAVE_SCREEN = "\u001b[?1049l";

function clearScreen(): string {
  return "\u001b[H\u001b[2J";
}

async function executeAction(rootDir: string, action: PendingAction): Promise<{
  body: string;
  offerCompact: boolean;
}> {
  const loaded = await loadEffectiveConfig({ targetDir: rootDir });
  const projectRoot = loaded.rootDir;

  switch (action.type) {
    case "session-start": {
      const result = runSessionStart({
        rootDir: projectRoot,
        ...(action.label.length > 0 ? { label: action.label } : {}),
      });
      const label = result.session.label ? ` (${result.session.label})` : "";
      return { body: `Session started: ${result.session.id}${label}`, offerCompact: false };
    }
    case "session-status": {
      const result = runSessionStatus(projectRoot);
      if (!result.session) {
        return {
          body: "No session found.\nStart one with memo-log session start <label>.",
          offerCompact: false,
        };
      }
      const lines = [
        `${result.session.id} [${result.session.status}] started ${result.session.startedAt}`,
      ];
      if (result.session.endedAt) {
        lines.push(`ended ${result.session.endedAt}`);
      }
      if (result.session.ticketId) {
        lines.push(`ticket ${result.session.ticketId}`);
      }
      return { body: lines.join("\n"), offerCompact: false };
    }
    case "session-attribution": {
      const status = await attributionStatus(projectRoot);
      return {
        body: `Attribution spans: ${status.spanCount} (chain ${status.chainValid ? "valid" : "INVALID"})\nCaptured ${status.counts.captured}; survived rewrite ${status.counts.survived_rewrite}; unattributed ${status.counts.unattributed}.`,
        offerCompact: false,
      };
    }
    case "session-end": {
      const result = await runSessionEnd({ loadedConfig: loaded });
      if (!result.ticket) {
        return {
          body: `Session ended: ${result.session.id} (no structural changes)`,
          offerCompact: false,
        };
      }
      return {
        body: [
          `Session ended: ${result.session.id}`,
          `Ticket: ${result.ticket.ticket.id}`,
          `Ticket JSON: ${result.ticket.jsonPath}`,
          `Ticket Markdown: ${result.ticket.markdownPath}`,
        ].join("\n"),
        offerCompact: false,
      };
    }
    case "query-category":
    case "query-file": {
      const payload = buildQueryPayload({
        rootDir: projectRoot,
        jsonPath: loaded.config.output.json,
        structural: action.type === "query-file",
        ...(action.type === "query-category" ? { category: action.category } : { file: action.file }),
        audience: "tech",
        weights: loaded.config.ranking.weights,
      });
      const rendered = renderQuery(payload);
      return { body: rendered, offerCompact: false };
    }
    case "compact-dry": {
      const result = runCompact({ rootDir: projectRoot, dryRun: true });
      return { body: renderCompact(result), offerCompact: true };
    }
    case "compact-apply": {
      const result = runCompact({ rootDir: projectRoot, dryRun: false });
      return { body: renderCompact(result), offerCompact: false };
    }
    case "export-markdown": {
      const path = writeMarkdownExport({ rootDir: projectRoot });
      return {
        body: `Ticket export: ${path}\nmemo-log wrote the file and did not run gh.`,
        offerCompact: false,
      };
    }
    case "export-github": {
      const result = writeGithubExport({ rootDir: projectRoot });
      return {
        body: `${renderGithubExport(result)}\nmemo-log wrote drafts only. It did not run gh or use the network.`,
        offerCompact: false,
      };
    }
    case "conflicts": {
      const reportPath = join(projectRoot, "MEMO_LOG_CONFLICTS.md");
      if (!existsSync(reportPath)) {
        return {
          body: [
            "No conflict report yet.",
            "Run memo-log scan --agent-ui to compare the current tree with the last agent-ui snapshot.",
            "The first run only stores a baseline. Run it again after the next scan to list conflicts.",
          ].join("\n"),
          offerCompact: false,
        };
      }
      const text = readFileSync(reportPath, "utf8");
      const clipped = text.split("\n").slice(0, 80).join("\n");
      const suffix = text.split("\n").length > 80 ? "\n… report truncated in the menu. Open MEMO_LOG_CONFLICTS.md for the full file." : "";
      return { body: `${clipped}${suffix}`, offerCompact: false };
    }
    case "settings": {
      const configPath = join(projectRoot, ".memolog.json");
      const prefsPath = join(projectRoot, ".memo-log", "session-prefs.json");
      const lines = [
        `Project config: ${configPath}`,
        `UI prefs: ${prefsPath}`,
        "",
        "Ranking weights and scan output come from .memolog.json.",
        "This menu stores only the last menu item and query filter. It does not change them.",
      ];
      if (!existsSync(configPath)) {
        lines.push("", "No .memolog.json yet. Create one with memo-log init.");
      }
      return { body: lines.join("\n"), offerCompact: false };
    }
    case "review":
      // Selecting Review tickets opens the local page directly; this branch
      // only exists so the reducer's action union stays exhaustive.
      return { body: "Opening the local review page…", offerCompact: false };
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

export async function runInteractiveMenu(options: InteractiveMenuOptions): Promise<number> {
  const input: MenuInput = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  let state = createInteractiveState(loadSessionPrefs(options.rootDir));
  const parser = createKeyParser();

  const persist = (): void => {
    saveSessionPrefs(options.rootDir, prefsFromState(state));
  };

  const draw = (): void => {
    output.write(`${clearScreen()}${renderMenu(state)}\n`);
  };

  const ownScreen = input.isTTY === true;
  input.setRawMode?.(true);
  input.resume?.();
  input.setEncoding?.("utf8");
  if (ownScreen) {
    output.write(ENTER_SCREEN);
  }
  persist();
  draw();

  return await new Promise<number>((resolve) => {
    let closed = false;
    let chain = Promise.resolve();
    let flushTimer: NodeJS.Timeout | undefined;
    let paused = false;

    const detach = (): void => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("close", onEnd);
      input.off("error", onError);
    };

    let screenLeft = false;
    const close = (code: number): void => {
      if (closed) {
        return;
      }
      closed = true;
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      input.setRawMode?.(false);
      input.pause?.();
      detach();
      if (ownScreen && !screenLeft) {
        output.write(LEAVE_SCREEN);
      }
      output.write("\n");
      resolve(code);
    };

    const applyKeys = async (keys: string[]): Promise<void> => {
      for (const key of keys) {
        if (closed) {
          return;
        }
        const previous = state;
        const result = applyMenuKey(state, key);
        state = result.state;
        if (result.effect.type === "quit") {
          persist();
          close(0);
          return;
        }
        if (result.effect.type === "open-review") {
          paused = true;
          persist();
          input.setRawMode?.(false);
          input.pause?.();
          detach();
          if (ownScreen) {
            output.write(LEAVE_SCREEN);
            screenLeft = true;
          }
          const openReview =
            options.openReview ??
            (async (rootDir: string) => {
              const { runReview } = await import("./review.js");
              return await runReview({ rootDir, view: "inbox" });
            });
          let code = 0;
          try {
            code = await openReview(options.rootDir);
          } catch (error) {
            code = error instanceof Error ? 1 : 1;
            output.write(
              `\nmemo-log review failed: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
          close(code);
          return;
        }
        if (result.effect.type === "execute") {
          const command = commandFor(result.effect.action);
          try {
            const executed = await executeAction(options.rootDir, result.effect.action);
            state = {
              ...state,
              pending: null,
              result: { command, body: executed.body, offerCompact: executed.offerCompact },
              message: undefined,
            };
          } catch (error) {
            const body = error instanceof CliError || error instanceof Error
              ? error.message
              : String(error);
            state = {
              ...state,
              pending: null,
              result: {
                command,
                body: body.length > 0 ? body : "Command failed.",
                offerCompact: false,
              },
            };
          }
        }
        if (result.effect.type === "none" && state === previous) {
          continue;
        }
        persist();
        draw();
      }
    };

    const enqueue = (keys: string[]): void => {
      if (keys.length === 0 || closed) {
        return;
      }
      chain = chain.then(() => applyKeys(keys));
    };

    const scheduleFlush = (): void => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
      }
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        enqueue(parser.flush());
      }, 50);
      flushTimer.unref?.();
    };

    function onData(chunk: string | Buffer): void {
      if (closed || paused) {
        return;
      }
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      enqueue(parser.feed(String(chunk)));
      if (parser.hasPending()) {
        scheduleFlush();
      }
    }

    function onEnd(): void {
      close(0);
    }

    function onError(error: Error): void {
      state = { ...state, message: `Input error: ${error.message}` };
      draw();
      close(1);
    }

    input.on("data", onData);
    input.on("end", onEnd);
    input.on("close", onEnd);
    input.on("error", onError);
  });
}
