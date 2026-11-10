import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { runFuseboxCli } from "../src/cli/fuseboxCli.js";

describe("Fusebox CLI entrypoint", () => {
  it("shows Fusebox help without loading legacy scan modules", async () => {
    let stdout = "";
    const exitCode = await runFuseboxCli(["--help"], {
      stdout: (text) => { stdout += text; },
      stderr: () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("fusebox");
    expect(stdout).toContain("proxy");
    expect(stdout).not.toContain("scan");
  });

  it("forwards a proxy command as argv without shell interpolation", async () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
    child.exitCode = null;
    const spawn = vi.fn((_binary: string, _args: string[], _options: { shell: false }) => {
      queueMicrotask(() => {
        child.exitCode = 7;
        child.emit("close", 7);
      });
      return child;
    });

    const exitCode = await runFuseboxCli(["proxy", "--", "mcp-server", "--arg", "two words"], {
      binaryPath: "fusebox-test-binary",
      spawn,
      stdout: () => undefined,
      stderr: () => undefined,
    });

    expect(spawn).toHaveBeenCalledWith(
      "fusebox-test-binary",
      ["proxy", "--", "mcp-server", "--arg", "two words"],
      expect.objectContaining({ shell: false }),
    );
    expect(exitCode).toBe(7);
  });

  it("returns a clear failure when the Rust executable is unavailable", async () => {
    let stderr = "";
    const exitCode = await runFuseboxCli(["proxy", "--", "server"], {
      binaryPath: null,
      stdout: () => undefined,
      stderr: (text) => { stderr += text; },
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Rust Fusebox executable was not found");
  });

  it("forwards proxy options (--framing, timeouts) before '--' separator", async () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
    child.exitCode = null;
    const spawn = vi.fn((_binary: string, _args: string[], _options: { shell: false }) => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit("close", 0);
      });
      return child;
    });

    const exitCode = await runFuseboxCli(
      ["proxy", "--framing", "content-length", "--shutdown-timeout", "10", "--grace-period", "2", "--", "mcp-server"],
      {
        binaryPath: "fusebox-test-binary",
        spawn,
        stdout: () => undefined,
        stderr: () => undefined,
      },
    );

    expect(spawn).toHaveBeenCalledWith(
      "fusebox-test-binary",
      ["proxy", "--framing", "content-length", "--shutdown-timeout", "10", "--grace-period", "2", "--", "mcp-server"],
      expect.objectContaining({ shell: false }),
    );
    expect(exitCode).toBe(0);
  });

  it("exits with 0 for -h and help aliases", async () => {
    let stdoutH = "";
    const exitCodeH = await runFuseboxCli(["-h"], {
      stdout: (text) => { stdoutH += text; },
      stderr: () => undefined,
    });
    expect(exitCodeH).toBe(0);
    expect(stdoutH).toContain("Usage: fusebox <command>");

    let stdoutHelp = "";
    const exitCodeHelp = await runFuseboxCli(["help"], {
      stdout: (text) => { stdoutHelp += text; },
      stderr: () => undefined,
    });
    expect(exitCodeHelp).toBe(0);
    expect(stdoutHelp).toContain("Usage: fusebox <command>");
  });

  it("forwards proxy --help to binary and returns 0", async () => {
    const child = new EventEmitter() as EventEmitter & { exitCode: number | null };
    child.exitCode = null;
    const spawn = vi.fn((_binary: string, _args: string[], _options: { shell: false }) => {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit("close", 0);
      });
      return child;
    });

    const exitCode = await runFuseboxCli(["proxy", "--help"], {
      binaryPath: "fusebox-test-binary",
      spawn,
      stdout: () => undefined,
      stderr: () => undefined,
    });

    expect(spawn).toHaveBeenCalledWith(
      "fusebox-test-binary",
      ["proxy", "--help"],
      expect.objectContaining({ shell: false }),
    );
    expect(exitCode).toBe(0);
  });
});
