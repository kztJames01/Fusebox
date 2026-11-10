import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertWatchAllowed,
  ensureWatchAllowed,
  isWatchConfirmed,
  watchConfirmPath,
  writeWatchConfirmed,
} from "../src/engine/watchConfirm.js";
import { CliError } from "../src/engine/errors.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("watch confirm", () => {
  it("requires confirmation on first watch without marker", async () => {
    const root = await tempDir("memolog-watch-confirm-");
    expect(isWatchConfirmed(root)).toBe(false);
    expect(() => assertWatchAllowed(root, false)).toThrow(CliError);
  });

  it("writes marker when confirm flag set", async () => {
    const root = await tempDir("memolog-watch-confirm-ok-");
    assertWatchAllowed(root, true);
    expect(isWatchConfirmed(root)).toBe(true);
    const marker = await fs.readFile(watchConfirmPath(root), "utf8");
    expect(marker.trim()).toBe("1");
  });

  it("prompts once and writes the marker on affirmative answer", async () => {
    const root = await tempDir("memolog-watch-confirm-prompt-");
    const questions: string[] = [];

    await ensureWatchAllowed(root, false, {
      interactive: true,
      prompt: async (question) => {
        questions.push(question);
        return "y";
      },
    });

    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("Allow? (y/N)");
    expect(isWatchConfirmed(root)).toBe(true);
  });

  it("does not write the marker on a negative answer", async () => {
    const root = await tempDir("memolog-watch-confirm-deny-");

    await expect(
      ensureWatchAllowed(root, false, {
        interactive: true,
        prompt: async () => "n",
      }),
    ).rejects.toThrow(CliError);

    expect(isWatchConfirmed(root)).toBe(false);
  });

  it("skips the prompt when confirmation already exists", async () => {
    const root = await tempDir("memolog-watch-confirm-existing-");
    writeWatchConfirmed(root);

    await ensureWatchAllowed(root, false, {
      interactive: false,
      prompt: async () => {
        throw new Error("prompt should not run");
      },
    });

    expect(isWatchConfirmed(root)).toBe(true);
  });

  it("fails clearly in non-interactive environments", async () => {
    const root = await tempDir("memolog-watch-confirm-noninteractive-");

    await expect(
      ensureWatchAllowed(root, false, { interactive: false }),
    ).rejects.toThrow(/non-interactive\/quiet mode cannot prompt/i);

    expect(isWatchConfirmed(root)).toBe(false);
  });

  it("fails clearly in quiet mode even with a TTY", async () => {
    const root = await tempDir("memolog-watch-confirm-quiet-");

    await expect(
      ensureWatchAllowed(root, false, {
        quiet: true,
        interactive: true,
        prompt: async () => "y",
      }),
    ).rejects.toThrow(/non-interactive\/quiet mode cannot prompt/i);

    expect(isWatchConfirmed(root)).toBe(false);
  });
});
