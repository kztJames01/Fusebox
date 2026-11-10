import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";
import { buildCurrentState, diffStates, detectBreakingChanges } from "../src/engine/diff.js";
import { materializeTicket } from "../src/engine/tickets.js";
import { TicketSchema } from "../src/types/ticket.js";
import type { AstExtract } from "../src/types/scan.js";

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

describe("session lifecycle and tickets", () => {
  it("starts a session, materializes a ticket on end, and exposes it via CLI", async () => {
    const root = await makeTempDir("memolog-session-");
    await runCli(["init", root]);
    await writeFile(
      root,
      "src/auth/login.ts",
      "export function login(email: string) { return email; }\n",
    );
    await runCli(["scan", root, "--format", "md", "--quiet"]);

    const startCapture = captureStdout();
    let startExit: number;
    try {
      startExit = await runCli(["session", "start", "auth work", "-C", root, "--json"]);
    } finally {
      startCapture.restore();
    }
    const started = JSON.parse(startCapture.chunks.join("").trim()) as {
      id: string;
      status: string;
      label?: string;
    };
    expect(startExit).toBe(0);
    expect(started.id).toMatch(/^S-[0-9a-f]{12}$/);
    expect(started.status).toBe("active");
    expect(started.label).toBe("auth work");

    await writeFile(
      root,
      "src/auth/login.ts",
      [
        "export function login(email: string, password: string) { return email && password; }",
        "export function resetPassword(email: string) { return email; }",
        "",
      ].join("\n"),
    );

    const endCapture = captureStdout();
    let endExit: number;
    try {
      endExit = await runCli(["session", "end", "-C", root, "--json"]);
    } finally {
      endCapture.restore();
    }

    expect(endExit).toBe(0);
    const payload = JSON.parse(endCapture.chunks.join("").trim()) as {
      session: { id: string; status: string; ticketId?: string };
      ticket: {
        id: string;
        state: string;
        changes: Array<{
          path: string;
          changeType: string;
          exportsAdded: string[];
          signaturesChanged: string[];
        }>;
        checklist: Array<{ ref: string; rule: string; verified: boolean }>;
        artifacts: Array<{ kind: string; path?: string }>;
      };
    };

    expect(payload.session.status).toBe("ended");
    expect(payload.session.ticketId).toBe(payload.ticket.id);
    expect(payload.ticket.id).toMatch(/^T-[0-9a-f]{12}$/);
    expect(payload.ticket.state).toBe("open");
    expect(payload.ticket.changes).toHaveLength(1);
    expect(payload.ticket.changes[0]?.path).toBe("src/auth/login.ts");
    expect(payload.ticket.changes[0]?.changeType).toBe("MODIFIED");
    expect(payload.ticket.changes[0]?.exportsAdded).toContain("resetPassword");
    expect(payload.ticket.changes[0]?.signaturesChanged).toContain("login");
    expect(payload.ticket.checklist).toHaveLength(1);
    expect(payload.ticket.checklist[0]?.rule).toBe("group_review");
    expect(payload.ticket.checklist.every((item) => /^\[.+:\d+(?::\d+)?\]$/.test(item.ref))).toBe(true);
    expect(payload.ticket.checklist.every((item) => item.verified)).toBe(true);
    expect(payload.ticket.artifacts.some((item) => item.kind === "file")).toBe(true);
    expect(payload.ticket.artifacts.some((item) => item.kind === "session")).toBe(true);

    TicketSchema.parse(payload.ticket);

    const ticketJson = await fs.readFile(
      path.join(root, ".memo-log", "tickets", `${payload.ticket.id}.json`),
      "utf8",
    );
    const ticketMarkdown = await fs.readFile(
      path.join(root, ".memo-log", "tickets", `${payload.ticket.id}.md`),
      "utf8",
    );
    expect(JSON.parse(ticketJson).id).toBe(payload.ticket.id);
    expect(ticketMarkdown).toContain("## Checklist");
    expect(ticketMarkdown).toContain(payload.ticket.id);

    const listCapture = captureStdout();
    let listExit: number;
    try {
      listExit = await runCli(["tickets", root, "--state", "open", "--json"]);
    } finally {
      listCapture.restore();
    }
    const listed = JSON.parse(listCapture.chunks.join("").trim()) as Array<{ id: string }>;
    expect(listExit).toBe(0);
    expect(listed.map((ticket) => ticket.id)).toContain(payload.ticket.id);

    const singleCapture = captureStdout();
    let singleExit: number;
    try {
      singleExit = await runCli(["ticket", payload.ticket.id, "-C", root]);
    } finally {
      singleCapture.restore();
    }
    expect(singleExit).toBe(0);
    expect(JSON.parse(singleCapture.chunks.join("").trim()).id).toBe(payload.ticket.id);
  });

  it("rejects session end without an active session", async () => {
    const root = await makeTempDir("memolog-session-none-");
    await runCli(["init", root]);
    const exit = await runCli(["session", "end", "-C", root]);
    expect(exit).toBe(2);
  });
});

describe("ticket materialization", () => {
  it("is deterministic and produces one grouped review item", () => {
    const before: AstExtract[] = [
      {
        file: "src/auth/login.ts",
        exports: [
          { name: "login", kind: "function", line: 1, signature: "function login(email)" },
        ],
        imports: [],
        signatures: ["function login(email)"],
      },
    ];
    const after: AstExtract[] = [
      {
        file: "src/auth/login.ts",
        exports: [
          {
            name: "login",
            kind: "function",
            line: 1,
            signature: "function login(email, password)",
          },
          { name: "logout", kind: "function", line: 5, signature: "function logout()" },
        ],
        imports: [],
        signatures: ["function login(email, password)", "function logout()"],
      },
    ];

    const previousState = buildCurrentState(before);
    const diffResult = diffStates(after, previousState);
    const breakingChanges = detectBreakingChanges(previousState, after);
    const session = {
      version: 1 as const,
      id: "S-0123456789ab",
      status: "active" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
      baselineStatePath: "/tmp/baseline.json",
    };

    const first = materializeTicket({
      session,
      diffResult,
      extracts: after,
      breakingChanges,
      generatedAt: "2026-01-01T00:10:00.000Z",
    });
    const second = materializeTicket({
      session,
      diffResult,
      extracts: after,
      breakingChanges,
      generatedAt: "2026-01-01T00:10:00.000Z",
    });

    expect(second.ticket).toEqual(first.ticket);
    expect(second.markdown).toBe(first.markdown);
    expect(first.ticket.groups).toHaveLength(1);
    expect(first.ticket.checklist).toHaveLength(1);
    expect(first.ticket.checklist[0]?.rule).toBe("group_review");
    expect(first.ticket.impactScore).toBeGreaterThan(0);
    expect(first.ticket.groups[0]?.kind).toBe("api_break");
  });
});
