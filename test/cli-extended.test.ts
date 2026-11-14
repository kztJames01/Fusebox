/**
 * Extended CLI tests: validates edge cases and invariants of the Fusebox
 * CLI layer that are not covered by the core unit tests.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import { runFuseboxCli } from "../src/cli/fuseboxCli.js";

function makeChild(exitCode: number) {
  const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
  child.exitCode = null;
  queueMicrotask(() => {
    child.exitCode = exitCode;
    child.emit("close", exitCode);
  });
  return child;
}

describe("cli-extended — subcommand routing", () => {
  it("receipts subcommand is forwarded to binary", async () => {
    const spawn = vi.fn(() => makeChild(0));
    const exitCode = await runFuseboxCli(["receipts"], {
      binaryPath: "fusebox-test",
      spawn,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(spawn).toHaveBeenCalledWith(
      "fusebox-test",
      ["receipts"],
      expect.objectContaining({ shell: false }),
    );
    expect(exitCode).toBe(0);
  });

  it("why subcommand is forwarded with receipt-id argument", async () => {
    const spawn = vi.fn(() => makeChild(0));
    await runFuseboxCli(["why", "rcpt-abc123"], {
      binaryPath: "fusebox-test",
      spawn,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(spawn).toHaveBeenCalledWith(
      "fusebox-test",
      ["why", "rcpt-abc123"],
      expect.anything(),
    );
  });

  it("verify subcommand is forwarded to binary", async () => {
    const spawn = vi.fn(() => makeChild(0));
    await runFuseboxCli(["verify"], {
      binaryPath: "fusebox-test",
      spawn,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(spawn).toHaveBeenCalledWith(
      "fusebox-test",
      ["verify"],
      expect.anything(),
    );
  });

  it("capabilities subcommand is forwarded to binary", async () => {
    const spawn = vi.fn(() => makeChild(0));
    await runFuseboxCli(["capabilities"], {
      binaryPath: "fusebox-test",
      spawn,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(spawn).toHaveBeenCalledWith(
      "fusebox-test",
      ["capabilities"],
      expect.anything(),
    );
  });
});

describe("cli-extended — error handling", () => {
  it("spawn error emits stderr message and returns exit 1", async () => {
    let stderr = "";
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
      child.exitCode = null;
      queueMicrotask(() => child.emit("error", new Error("ENOENT: no such file")));
      return child;
    });
    const exitCode = await runFuseboxCli(["version"], {
      binaryPath: "fusebox-test",
      spawn,
      stdout: () => undefined,
      stderr: (t) => { stderr += t; },
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("ENOENT");
  });

  it("null exit code from child resolves to exit 1", async () => {
    const spawn = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
      child.exitCode = null;
      queueMicrotask(() => {
        child.exitCode = null;
        child.emit("close", null);
      });
      return child;
    });
    const exitCode = await runFuseboxCli(["version"], {
      binaryPath: "fusebox-test",
      spawn,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(exitCode).toBe(1);
  });

  it("argv arguments with spaces are passed verbatim without shell expansion", async () => {
    const spawn = vi.fn(() => makeChild(0));
    await runFuseboxCli(["run", "--", "/bin/echo", "path with spaces", "arg2"], {
      binaryPath: "fusebox-test",
      spawn,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    const calledArgs = (spawn.mock.calls[0] as unknown[])[1] as string[];
    expect(calledArgs).toContain("path with spaces");
    expect(calledArgs).not.toContain("path");
  });
});

describe("cli-extended — output contract", () => {
  it("help output contains all documented subcommands", async () => {
    let stdout = "";
    await runFuseboxCli(["--help"], {
      stdout: (t) => { stdout += t; },
      stderr: () => undefined,
    });
    const commands = ["init", "run", "proxy", "receipts", "why", "verify", "policy", "version"];
    for (const cmd of commands) {
      expect(stdout).toContain(cmd);
    }
  });

  it("help output does not mention scan or Memo-log legacy features", async () => {
    let stdout = "";
    await runFuseboxCli(["--help"], {
      stdout: (t) => { stdout += t; },
      stderr: () => undefined,
    });
    expect(stdout.toLowerCase()).not.toContain("scan");
    expect(stdout.toLowerCase()).not.toContain("memo-log");
  });
});
