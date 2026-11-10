import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";
import {
  AI_TOOL_SIGNATURES,
  detectAiTools,
  getHookSnippet,
  runAutoSession,
} from "../src/engine/sessionDetection.js";
import { loadCurrentSession } from "../src/engine/sessions.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
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

describe("AI tool detection", () => {
  it("detects local markers deterministically and ignores absent tools", async () => {
    const root = await makeTempDir("memolog-detect-");
    await fs.mkdir(path.join(root, ".claude"), { recursive: true });
    await fs.mkdir(path.join(root, ".cursor"), { recursive: true });
    await fs.writeFile(path.join(root, "CLAUDE.md"), "# instructions\n", "utf8");

    const tools = detectAiTools(root);
    expect(tools.map((tool) => tool.id)).toEqual(["claude-code", "cursor"]);
    expect(tools[0]?.evidence).toEqual([".claude", "CLAUDE.md"]);
    expect(tools[0]?.hookSupport).toBe("documented");
    expect(tools[1]?.hookSupport).toBe("documented");
  });

  it("declares each marker path at most once per tool", () => {
    for (const signature of AI_TOOL_SIGNATURES) {
      expect(new Set(signature.markers).size).toBe(signature.markers.length);
    }
    const cline = AI_TOOL_SIGNATURES.find((signature) => signature.id === "cline");
    expect(cline?.markers).toEqual([".clinerules"]);
  });

  it("starts a session only when a marker exists and none is active", async () => {
    const empty = await makeTempDir("memolog-detect-empty-");
    const none = runAutoSession({ rootDir: empty, now: "2026-03-01T00:00:00.000Z" });
    expect(none.started).toBe(false);
    expect(none.reason).toBe("no-tools");

    const root = await makeTempDir("memolog-detect-start-");
    await fs.mkdir(path.join(root, ".claude"), { recursive: true });
    const started = runAutoSession({ rootDir: root, now: "2026-03-01T00:00:00.000Z" });
    expect(started.started).toBe(true);
    expect(started.reason).toBe("started");
    expect(started.session?.label).toBe("auto: claude-code");
    expect(loadCurrentSession(root)?.status).toBe("active");

    const again = runAutoSession({ rootDir: root, now: "2026-03-01T00:05:00.000Z" });
    expect(again.started).toBe(false);
    expect(again.reason).toBe("active-session");
    expect(again.session?.id).toBe(started.session?.id);
  });

  it("returns parseable hook snippets and never writes files", async () => {
    const root = await makeTempDir("memolog-hooks-");
    const snippet = getHookSnippet("claude-code");
    expect(snippet.file).toBe(".claude/settings.json");
    const parsed = JSON.parse(snippet.snippet) as {
      hooks: { SessionStart: unknown[]; SessionEnd: unknown[] };
    };
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.SessionEnd).toHaveLength(1);
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe("session detection CLI", () => {
  it("prints detection and auto-session JSON", async () => {
    const root = await makeTempDir("memolog-detect-cli-");
    await fs.mkdir(path.join(root, ".claude"), { recursive: true });

    const detectCapture = captureStdout();
    let detectExit: number;
    try {
      detectExit = await runCli(["session", "detect", "-C", root, "--json"]);
    } finally {
      detectCapture.restore();
    }
    expect(detectExit).toBe(0);
    const detected = JSON.parse(detectCapture.chunks.join("").trim()) as {
      tools: Array<{ id: string }>;
      session: unknown;
    };
    expect(detected.tools.map((tool) => tool.id)).toEqual(["claude-code"]);
    expect(detected.session).toBeNull();

    const autoCapture = captureStdout();
    let autoExit: number;
    try {
      autoExit = await runCli(["session", "auto", "-C", root, "--json"]);
    } finally {
      autoCapture.restore();
    }
    expect(autoExit).toBe(0);
    const auto = JSON.parse(autoCapture.chunks.join("").trim()) as {
      started: boolean;
      session: { status: string };
    };
    expect(auto.started).toBe(true);
    expect(auto.session.status).toBe("active");
  });

  it("prints hook snippets", async () => {
    const capture = captureStdout();
    let exit: number;
    try {
      exit = await runCli(["session", "hooks", "opencode", "--json"]);
    } finally {
      capture.restore();
    }
    expect(exit).toBe(0);
    const snippet = JSON.parse(capture.chunks.join("").trim()) as {
      tool: string;
      snippet: string;
    };
    expect(snippet.tool).toBe("opencode");
    expect(snippet.snippet).toContain("session.created");
  });
});
