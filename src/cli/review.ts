// `memo-log review` — start the local review page for the IDE integrated browser.
//
// By default the page is meant for the IDE's integrated browser (VS Code /
// Cursor Simple Browser or built-in Browser Tab) and never launches an external
// OS browser unless `--open` is explicitly passed. When the IDE provides a
// `$BROWSER` helper script in the terminal environment, that helper is invoked
// unless `--no-open` is set.
import { spawn } from "node:child_process";

import { CliError, ExitCode } from "../engine/errors.js";
import {
  DEFAULT_REVIEW_IDLE_MS,
  startReviewServer,
  type ReviewServerHandle,
} from "../server/reviewServer.js";

export type ReviewView = "inbox" | "board" | "context" | "graph";

export interface ReviewCommandOptions {
  rootDir: string;
  port?: number | undefined;
  allowWrites?: boolean | undefined;
  /** true = open external/helper browser, false = never, undefined = IDE helper only. */
  open?: boolean | undefined;
  idleMinutes?: number | undefined;
  output?: NodeJS.WritableStream | undefined;
  /** Which review view the printed URL should open. Defaults to inbox. */
  view?: ReviewView | undefined;
  /** Test hook: resolve instead of waiting for SIGINT/idle. */
  onReady?: ((handle: ReviewServerHandle) => void | Promise<void>) | undefined;
}

export interface ReviewLaunchOptions {
  tty: boolean;
  json?: boolean | undefined;
  quiet?: boolean | undefined;
  /** Filter flags would be lost in the web view, so fall back to text output. */
  filtered?: boolean | undefined;
}

/**
 * Human review should open the local page instead of the terminal browser.
 * JSON, quiet, non-TTY, and filtered one-shot output keep their old behavior.
 */
export function shouldLaunchReview(options: ReviewLaunchOptions): boolean {
  if (options.json === true || options.quiet === true) return false;
  if (options.tty !== true) return false;
  return options.filtered !== true;
}

export function isIdeTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env["TERM_PROGRAM"] === "vscode" ||
    env["CURSOR_TRACE_ID"] !== undefined ||
    env["VSCODE_IPC_HOOK_CLI"] !== undefined ||
    env["ANTIGRAVITY_VSCODE_HOST"] !== undefined
  );
}

/**
 * Default (`open === undefined`): only auto-run when the IDE injected a
 * `$BROWSER` opener script, never the OS default browser. Explicit `--open`
 * forces opening; `--no-open` disables it.
 */
export function shouldAutoOpen(
  open: boolean | undefined,
  isTty: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (open !== undefined) return open;
  const browserEnv = env["BROWSER"]?.trim();
  return isTty && browserEnv !== undefined && browserEnv.length > 0;
}

export function reviewUrl(handle: ReviewServerHandle, view: ReviewView = "inbox"): string {
  return `http://${handle.host}:${handle.port}/t/${handle.token}/${view}`;
}

export function renderReviewBanner(
  handle: ReviewServerHandle,
  allowWrites: boolean,
  view: ReviewView = "inbox",
): string {
  return [
    "✓ memo-log review is running (local only, no outbound network)",
    "",
    `  Review URL (with token):  ${reviewUrl(handle, view)}`,
    `  Local origin (IDE probe): http://${handle.host}:${handle.port}/`,
    `  One-time token:           ${handle.token}`,
    `  View:                     ${view}`,
    "",
    "  IDE integrated browser:",
    "    • Cmd/Ctrl+click the Review URL above to open it inside your IDE browser tab, or",
    "    • Cmd+Shift+P → \"Simple Browser: Show\" → paste the Review URL above.",
    allowWrites
      ? "  Writes are enabled: approve, bounce and check actions call the same core as the CLI."
      : "  Read-only. Restart with --allow-writes to approve, bounce, or check items.",
    "",
    "  Press Ctrl+C to stop. The server also stops after an idle timeout.",
  ].join("\n");
}

function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): void {
  const browserEnv = env["BROWSER"]?.trim();
  const command =
    browserEnv !== undefined && browserEnv.length > 0
      ? browserEnv
      : process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer"
          : "xdg-open";
  try {
    const child = spawn(command, [url], { stdio: "ignore", detached: true, shell: false });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is already printed.
  }
}

export async function runReview(options: ReviewCommandOptions): Promise<number> {
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
  ) {
    throw new CliError("--port must be an integer between 0 and 65535.", ExitCode.ConfigError);
  }
  const output = options.output ?? process.stdout;
  const view = options.view ?? "inbox";
  const handle = await startReviewServer({
    rootDir: options.rootDir,
    port: options.port,
    allowWrites: options.allowWrites,
    idleTimeoutMs:
      options.idleMinutes !== undefined ? options.idleMinutes * 60_000 : DEFAULT_REVIEW_IDLE_MS,
  });
  output.write(`${renderReviewBanner(handle, options.allowWrites === true, view)}\n`);

  if (options.onReady) {
    await options.onReady(handle);
    await handle.close();
    return 0;
  }
  if (shouldAutoOpen(options.open, process.stdout.isTTY === true)) {
    openBrowser(reviewUrl(handle, view));
  }

  const stop = (): void => {
    void handle.close();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await handle.closed;
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  output.write("review server stopped\n");
  return 0;
}
