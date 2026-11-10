import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";
import {
  applyMenuKey,
  commandFor,
  createInteractiveState,
  prefsFromState,
  renderCompactHelp,
  renderMenu,
  runInteractiveMenu,
} from "../src/cli/interactiveMenu.js";
import { renderQuery } from "../src/cli/query.js";
import {
  loadSessionPrefs,
  saveSessionPrefs,
} from "../src/cli/sessionPrefs.js";
import type { QueryPayload } from "../src/engine/contextQuery.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function fakeTty(): PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void } {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (mode: boolean) => void;
  };
  input.isTTY = true;
  input.setRawMode = () => {};
  return input;
}

function collect(output: PassThrough): () => string {
  const chunks: string[] = [];
  output.on("data", (chunk: Buffer | string) => {
    chunks.push(String(chunk));
  });
  return () => chunks.join("");
}

async function waitFor(read: () => string, needle: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (read().includes(needle)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(needle)}.\n${read().slice(-800)}`);
}

describe("interactive menu", () => {
  it("keeps bare memo-log on the keyboard menu", async () => {
    const input = fakeTty();
    const output = new PassThrough();
    const read = collect(output);
    const exit = runCli([], { input, output });
    await waitFor(read, "Review tickets");
    expect(read()).not.toContain("Review URL (with token)");
    input.write("q");
    await expect(exit).resolves.toBe(0);
  });

  it("prints compact help and returns when stdin is not a TTY", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const read = collect(output);

    const exit = await Promise.race([
      runCli([], { input, output }),
      new Promise<number>((_resolve, reject) => {
        setTimeout(() => reject(new Error("non-TTY memo-log hung")), 1000);
      }),
    ]);

    expect(exit).toBe(0);
    expect(read()).toBe(`${renderCompactHelp()}\n`);
    expect(read()).toContain("memo-log mcp -C <dir>");
    expect(read()).toContain("memo-log scan [dir]");
    expect(read()).not.toContain("\u001b[2J");
  });

  it("still prints commander help for --help", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const exit = await Promise.race([
        runCli(["--help"]),
        new Promise<number>((_resolve, reject) => {
          setTimeout(() => reject(new Error("--help hung")), 2000);
        }),
      ]);
      expect(exit).toBe(0);
      expect(chunks.join("")).toContain("scan");
    } finally {
      process.stdout.write = original;
    }
  });

  it("maps menu actions to stable command strings", () => {
    expect(commandFor({ type: "session-status" })).toBe("memo-log session status");
    expect(commandFor({ type: "session-end" })).toBe("memo-log session end");
    expect(commandFor({ type: "session-start", label: "auth refactor" })).toBe(
      'memo-log session start "auth refactor"',
    );
    expect(commandFor({ type: "review" })).toBe("memo-log review");
    expect(commandFor({ type: "query-category", category: "auth" })).toBe(
      "memo-log query --category auth",
    );
    expect(commandFor({ type: "query-file", file: "src/auth/login.ts" })).toBe(
      "memo-log query --structural --file src/auth/login.ts",
    );
    expect(commandFor({ type: "compact-dry" })).toBe("memo-log compact --dry-run");
    expect(commandFor({ type: "compact-apply" })).toBe("memo-log compact");
    expect(commandFor({ type: "export-markdown" })).toBe("memo-log export markdown");
    expect(commandFor({ type: "export-github" })).toBe("memo-log export github");
    expect(commandFor({ type: "conflicts" })).toBe("memo-log scan --agent-ui");

    const again = commandFor({ type: "query-file", file: "src/auth/login.ts" });
    expect(again).toBe(commandFor({ type: "query-file", file: "src/auth/login.ts" }));

    let state = createInteractiveState();
    state = applyMenuKey(state, "4").state;
    expect(state.pending).toEqual({ type: "compact-dry" });
    expect(renderMenu(state)).toContain("Will run:");
    expect(renderMenu(state)).toContain("memo-log compact --dry-run");

    const help = applyMenuKey(createInteractiveState(), "?").state;
    const overlay = renderMenu(help);
    expect(overlay).toContain("Keys");
    expect(overlay).toContain("memo-log review");
    expect(overlay).toContain("memo-log query --category <category>");
    expect(overlay).toContain("memo-log scan --agent-ui");
  });

  it("shows an empty query result and a query error without hanging", async () => {
    const empty: QueryPayload = {
      kind: "memo-log-query",
      schema: 1,
      audience: "tech",
      ordering: "ranked",
      filters: { limit: 20 },
      sources: {
        structural: false,
        targetEntries: 0,
        changed: 0,
        sameCategory: 0,
        dependents: 0,
        dependencies: 0,
      },
      totalCandidates: 0,
      entries: [],
    };
    const rendered = renderMenu({
      ...createInteractiveState(),
      result: {
        command: "memo-log query --category auth",
        body: renderQuery(empty),
        offerCompact: false,
      },
    });
    expect(rendered).toContain("Ran: memo-log query --category auth");
    expect(rendered).toContain("No reference-anchored entries matched the query.");

    const root = await makeTempDir("memolog-menu-query-");
    await runCli(["init", root]);
    const input = fakeTty();
    const output = new PassThrough();
    const read = collect(output);
    const exit = runInteractiveMenu({ rootDir: root, input, output });

    input.write("3");
    await waitFor(read, "Query by category");
    input.write("1");
    await waitFor(read, "Category");
    input.write("auth\r");
    await waitFor(read, "memo-log query --category auth");
    input.write("\r");
    await waitFor(read, "Unable to read");
    expect(read()).toContain("Ran: memo-log query --category auth");
    input.write("q");
    await expect(exit).resolves.toBe(0);
  });

  it("runs the local review page from the Review tickets menu item", async () => {
    const root = await makeTempDir("memolog-menu-review-");
    await runCli(["init", root]);
    const input = fakeTty();
    const output = new PassThrough();
    const read = collect(output);
    const opened: string[] = [];
    const exit = runInteractiveMenu({
      rootDir: root,
      input,
      output,
      openReview: async (dir) => {
        opened.push(dir);
        return 0;
      },
    });

    input.write("2");
    await waitFor(read, "Will run:");
    expect(read()).toContain("memo-log review");
    input.write("\r");
    await expect(exit).resolves.toBe(0);
    expect(opened).toEqual([root]);
    expect(read()).not.toContain("No tickets match this filter.");
  });

  it("keeps UI prefs out of scan output", async () => {
    const root = await makeTempDir("memolog-menu-prefs-");
    await runCli(["init", root]);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "login.ts"),
      "export function login(email: string) { return email; }\n",
      "utf8",
    );
    await runCli(["scan", root, "--format", "json", "--quiet"]);
    const before = JSON.parse(await fs.readFile(path.join(root, "MEMO_LOG.json"), "utf8")) as {
      generatedAt?: string;
    };
    before.generatedAt = "normalized";

    saveSessionPrefs(root, { schema: 1, lastMenu: "query", filter: "auth" });
    expect(loadSessionPrefs(root)).toEqual({ schema: 1, lastMenu: "query", filter: "auth" });
    expect(createInteractiveState(loadSessionPrefs(root)).selected).toBe(2);
    expect(prefsFromState(createInteractiveState(loadSessionPrefs(root))).lastMenu).toBe("query");

    await runCli(["scan", root, "--format", "json", "--quiet"]);
    const after = JSON.parse(await fs.readFile(path.join(root, "MEMO_LOG.json"), "utf8")) as {
      generatedAt?: string;
    };
    after.generatedAt = "normalized";
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("session-prefs");
    expect(JSON.stringify(after)).not.toContain("lastMenu");
  });
});
