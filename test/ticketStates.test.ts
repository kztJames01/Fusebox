import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";
import { loadTicket } from "../src/engine/tickets.js";
import { getSessionPaths } from "../src/engine/sessions.js";
import {
  checklistProgress,
  markChecklistItem,
  transitionTicket,
} from "../src/engine/ticketCommands.js";

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

async function createTicket(root: string): Promise<string> {
  await runCli(["init", root]);
  await writeFile(root, "src/auth/login.ts", "export function login(email: string) { return email; }\n");
  await runCli(["scan", root, "--format", "md", "--quiet"]);
  await runCli(["session", "start", "state test", "-C", root, "--json"]);
  await writeFile(
    root,
    "src/auth/login.ts",
    [
      "export function login(email: string, password: string) { return email && password; }",
      "export function logout() {}",
      "",
    ].join("\n"),
  );
  const capture = captureStdout();
  try {
    const exit = await runCli(["session", "end", "-C", root, "--json"]);
    expect(exit).toBe(0);
  } finally {
    capture.restore();
  }
  const payload = JSON.parse(capture.chunks.join("").trim()) as { ticket: { id: string } };
  return payload.ticket.id;
}

function checkAll(root: string, id: string): void {
  const ticket = loadTicket(root, id)!;
  ticket.checklist.forEach((item) => {
    markChecklistItem({ rootDir: root, ticketId: id, item: item.id, evidence: item.ref });
  });
}

describe("ticket state transitions", () => {
  it("moves open → needs_review → done and records human events", async () => {
    const root = await makeTempDir("memolog-ticket-state-");
    const id = await createTicket(root);

    const accepted = transitionTicket({
      rootDir: root,
      ticketId: id,
      action: "accept",
      now: "2026-02-01T00:00:00.000Z",
    });
    expect(accepted.previousState).toBe("open");
    expect(accepted.ticket.state).toBe("needs_review");
    expect(accepted.ticket.stateHistory.map((event) => event.state)).toEqual(["open", "needs_review"]);
    expect(accepted.ticket.stateHistory.at(-1)?.actor).toBe("human");

    checkAll(root, id);
    const done = transitionTicket({
      rootDir: root,
      ticketId: id,
      action: "done",
      now: "2026-02-01T00:05:00.000Z",
    });
    expect(done.ticket.state).toBe("done");
    expect(loadTicket(root, id)?.state).toBe("done");
  });

  it("requires a reason to block and clears it on reopen", async () => {
    const root = await makeTempDir("memolog-ticket-block-");
    const id = await createTicket(root);

    expect(() =>
      transitionTicket({ rootDir: root, ticketId: id, action: "block" }),
    ).toThrow(/requires a short reason/);

    const blocked = transitionTicket({
      rootDir: root,
      ticketId: id,
      action: "block",
      reason: "waiting on API contract",
      now: "2026-02-01T00:00:00.000Z",
    });
    expect(blocked.ticket.state).toBe("blocked");
    expect(blocked.ticket.blockedReason).toBe("waiting on API contract");

    const reopened = transitionTicket({
      rootDir: root,
      ticketId: id,
      action: "reopen",
      now: "2026-02-01T00:10:00.000Z",
    });
    expect(reopened.ticket.state).toBe("needs_review");
    expect(reopened.ticket.blockedReason).toBeUndefined();
    expect(reopened.ticket.stateHistory.at(-1)?.state).toBe("needs_review");
  });

  it("rejects invalid transitions", async () => {
    const root = await makeTempDir("memolog-ticket-invalid-");
    const id = await createTicket(root);
    checkAll(root, id);
    expect(() =>
      transitionTicket({ rootDir: root, ticketId: id, action: "done" }),
    ).not.toThrow();
    expect(() =>
      transitionTicket({ rootDir: root, ticketId: id, action: "accept" }),
    ).toThrow(/Cannot accept/);
  });

  it("marks checklist items by id or index and is idempotent", async () => {
    const root = await makeTempDir("memolog-ticket-checklist-");
    const id = await createTicket(root);
    const ticket = loadTicket(root, id);
    expect(ticket).not.toBeNull();
    const first = ticket!.checklist[0]!;

    const marked = markChecklistItem({
      rootDir: root,
      ticketId: id,
      item: first.id,
      evidence: first.ref,
      now: "2026-02-01T00:00:00.000Z",
    });
    expect(marked.changed).toBe(true);
    expect(marked.item.status).toBe("done");
    expect(marked.item.evidence).toBe(first.ref);

    const again = markChecklistItem({ rootDir: root, ticketId: id, item: first.id, evidence: first.ref });
    expect(again.changed).toBe(false);

    markChecklistItem({ rootDir: root, ticketId: id, item: "1", evidence: first.ref });
    const reloaded = loadTicket(root, id)!;
    expect(reloaded.checklist[0]?.status).toBe("done");
    expect(checklistProgress(reloaded).done).toBe(1);
    expect(reloaded.checklist[0]?.id).toBe(first.id);
  });
});

describe("ticket state CLI", () => {
  it("supports accept, done, block, reopen, check, and uncheck", async () => {
    const root = await makeTempDir("memolog-ticket-cli-");
    const id = await createTicket(root);

    expect(await runCli(["ticket", id, "accept", "-C", root])).toBe(0);
    expect(loadTicket(root, id)?.state).toBe("needs_review");

    expect(await runCli(["ticket", id, "done", "-C", root])).toBe(2);
    checkAll(root, id);
    expect(await runCli(["ticket", id, "done", "-C", root])).toBe(0);
    expect(loadTicket(root, id)?.state).toBe("done");

    expect(await runCli(["ticket", id, "reopen", "-C", root])).toBe(0);
    expect(loadTicket(root, id)?.state).toBe("needs_review");

    expect(await runCli(["ticket", id, "block", "-C", root])).toBe(2);
    expect(await runCli(["ticket", id, "block", "external dependency", "-C", root])).toBe(0);
    expect(loadTicket(root, id)?.blockedReason).toBe("external dependency");

    const itemId = loadTicket(root, id)!.checklist[0]!.id;
    expect(await runCli(["ticket", id, "uncheck", itemId, "-C", root])).toBe(0);
    expect(await runCli(["ticket", id, "check", itemId, "-C", root])).toBe(2);
    expect(await runCli(["ticket", id, "check", itemId, "not evidence!", "-C", root])).toBe(2);
    expect(await runCli(["ticket", id, "check", itemId, "src/a.ts:3", "-C", root])).toBe(2);
    expect(await runCli(["ticket", id, "check", itemId, "[src/a.ts:3]", "-C", root])).toBe(0);
    expect(loadTicket(root, id)?.checklist[0]?.status).toBe("done");
    expect(loadTicket(root, id)?.checklist[0]?.evidence).toBe("[src/a.ts:3]");
    expect(await runCli(["ticket", id, "uncheck", itemId, "-C", root])).toBe(0);
    const unchecked = loadTicket(root, id)?.checklist[0];
    expect(unchecked?.status).toBe("pending");
    expect(unchecked?.evidence).toBeUndefined();
  });
});

describe("id validation", () => {
  it("rejects malformed ticket ids before building a path", () => {
    expect(() => loadTicket("/tmp/memo-log-root", "../../etc/passwd")).toThrow(/Invalid ticket id/);
    expect(() => loadTicket("/tmp/memo-log-root", "T-../../escape")).toThrow(/Invalid ticket id/);
    expect(() =>
      transitionTicket({
        rootDir: "/tmp/memo-log-root",
        ticketId: "../T-000000000000",
        action: "accept",
      }),
    ).toThrow(/Invalid ticket id/);
  });

  it("rejects malformed session ids before building a path", () => {
    expect(() => getSessionPaths("/tmp/memo-log-root", "../session")).toThrow(/Invalid session id/);
    expect(() => getSessionPaths("/tmp/memo-log-root", "S-../../escape")).toThrow(
      /Invalid session id/,
    );
  });

  it("returns a config error through the CLI for a malformed ticket id", async () => {
    const root = await makeTempDir("memolog-ticket-bad-id-");
    await createTicket(root);
    expect(await runCli(["ticket", "../../etc/passwd", "accept", "-C", root])).toBe(2);
  });
});
