/**
 * Agent UI workflow tests: validates the expected behavior of the
 * agent-facing CLI surface for common workflows — init, run, policy dry-run.
 * Tests that the output shapes match the declared contract.
 */

import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import { runFuseboxCli } from "../src/cli/fuseboxCli.js";

// ── Helper ────────────────────────────────────────────────────────────────────

function makeChild(exitCode: number) {
  const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
  child.exitCode = null;
  queueMicrotask(() => {
    child.exitCode = exitCode;
    child.emit("close", exitCode);
  });
  return child;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("agent UI workflow — help and discovery", () => {
  it("--help returns exit 0 with command list", async () => {
    let stdout = "";
    const exitCode = await runFuseboxCli(["--help"], {
      stdout: (t) => { stdout += t; },
      stderr: () => undefined,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("init");
    expect(stdout).toContain("run");
    expect(stdout).toContain("proxy");
  });

  it("unknown command returns non-zero exit", async () => {
    const exitCode = await runFuseboxCli(["unknown-command-xyz"], {
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(exitCode).not.toBe(0);
  });

  it("version command is forwarded to binary", async () => {
    const spawn = vi.fn((_binary: string, _args: string[], _opts: unknown) =>
      makeChild(0),
    );
    const exitCode = await runFuseboxCli(["version"], {
      binaryPath: "fusebox-test",
      spawn,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(spawn).toHaveBeenCalledWith(
      "fusebox-test",
      ["version"],
      expect.objectContaining({ shell: false }),
    );
    expect(exitCode).toBe(0);
  });
});

describe("agent UI workflow — init command", () => {
  it("init is forwarded to binary with original argv", async () => {
    const spawn = vi.fn((_binary: string, _args: string[], _opts: unknown) =>
      makeChild(0),
    );
    const exitCode = await runFuseboxCli(["init", "--session-id", "sess-001"], {
      binaryPath: "fusebox-test",
      spawn,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(spawn).toHaveBeenCalledWith(
      "fusebox-test",
      ["init", "--session-id", "sess-001"],
      expect.objectContaining({ shell: false }),
    );
    expect(exitCode).toBe(0);
  });

  it("init --overwrite is forwarded as-is", async () => {
    const spawn = vi.fn((_binary: string, _args: string[], _opts: unknown) =>
      makeChild(0),
    );
    await runFuseboxCli(["init", "--overwrite"], {
      binaryPath: "fusebox-test",
      spawn,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(spawn).toHaveBeenCalledWith(
      "fusebox-test",
      ["init", "--overwrite"],
      expect.anything(),
    );
  });
});

describe("agent UI workflow — run command", () => {
  it("run -- <exe> [args] is forwarded without shell interpolation", async () => {
    const spawn = vi.fn((_binary: string, _args: string[], _opts: unknown) =>
      makeChild(0),
    );
    await runFuseboxCli(["run", "--", "/bin/echo", "hello world"], {
      binaryPath: "fusebox-test",
      spawn,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(spawn).toHaveBeenCalledWith(
      "fusebox-test",
      ["run", "--", "/bin/echo", "hello world"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("run with non-zero child exit returns that exit code", async () => {
    const spawn = vi.fn((_binary: string, _args: string[], _opts: unknown) =>
      makeChild(42),
    );
    const exitCode = await runFuseboxCli(["run", "--", "cargo", "test"], {
      binaryPath: "fusebox-test",
      spawn,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(exitCode).toBe(42);
  });
});

describe("agent UI workflow — policy command", () => {
  it("policy dry-run is forwarded to binary", async () => {
    const spawn = vi.fn((_binary: string, _args: string[], _opts: unknown) =>
      makeChild(1),
    );
    const exitCode = await runFuseboxCli(
      ["policy", "dry-run", "--executable", "/bin/rm", "--argv", "-rf"],
      {
        binaryPath: "fusebox-test",
        spawn,
        stdout: () => undefined,
        stderr: () => undefined,
      },
    );
    expect(spawn).toHaveBeenCalledWith(
      "fusebox-test",
      ["policy", "dry-run", "--executable", "/bin/rm", "--argv", "-rf"],
      expect.objectContaining({ shell: false }),
    );
    expect(exitCode).toBe(1);
  });
});

describe("agent UI workflow — missing binary", () => {
  it("returns non-zero exit and error message when binary not found", async () => {
    let stderr = "";
    const exitCode = await runFuseboxCli(["run", "--", "cargo", "test"], {
      binaryPath: null,
      stdout: () => undefined,
      stderr: (t) => { stderr += t; },
    });
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Rust Fusebox executable was not found");
  });
});
