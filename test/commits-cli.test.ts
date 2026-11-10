import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/cli/runCli.js";

const execFileAsync = promisify(execFile);

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

describe("cli commits command", () => {
  it("fails when the target is not a git repository", async () => {
    const root = await makeTempDir("memolog-cli-commits-nogit-");
    const exitCode = await runCli(["commits", root]);
    expect(exitCode).toBe(2);
  });

  it("prints deterministic grouped commit suggestions in dry-run mode", async () => {
    const root = await makeTempDir("memolog-cli-commits-");

    await git(root, ["init"]);
    await git(root, ["config", "user.name", "AI Memory"]);
    await git(root, ["config", "user.email", "memolog@example.com"]);

    await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
    await fs.mkdir(path.join(root, "src", "api"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "auth", "seed.ts"), "export const seed = true;\n", "utf8");
    await fs.writeFile(path.join(root, "src", "api", "seed.ts"), "export const seed = true;\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "chore: baseline"]);

    await fs.writeFile(path.join(root, "src", "auth", "login.ts"), "export const login = () => true;\n", "utf8");
    await fs.writeFile(path.join(root, "src", "api", "client.ts"), "export const client = {};\n", "utf8");
    await fs.writeFile(path.join(root, "package.json"), "{ \"name\": \"x\" }\n", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitCode = await runCli(["commits", root, "--dry-run"]);
    const output = logSpy.mock.calls.flat().join("\n");
    logSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(output).toContain("Suggested commit groups:");
    expect(output).toContain("feat(auth):");
    expect(output).toContain("feat(api):");
    expect(output).toContain("chore(chore):");
    expect(output).toContain("Dry-run mode.");
  });

  it("accepts commit alias command", async () => {
    const root = await makeTempDir("memolog-cli-commit-alias-");

    await git(root, ["init"]);
    await git(root, ["config", "user.name", "AI Memory"]);
    await git(root, ["config", "user.email", "memolog@example.com"]);

    await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "auth", "seed.ts"), "export const seed = true;\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "chore: baseline"]);

    await fs.writeFile(path.join(root, "src", "auth", "login.ts"), "export const login = () => true;\n", "utf8");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitCode = await runCli(["commit", root, "--dry-run"]);
    const output = logSpy.mock.calls.flat().join("\n");
    logSpy.mockRestore();

    expect(exitCode).toBe(0);
    expect(output).toContain("Suggested commit groups:");
    expect(output).toContain("feat(auth):");
  });
});
