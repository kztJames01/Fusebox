import { spawn as nodeSpawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

interface SpawnedChild {
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
}

type Spawn = (
  command: string,
  args: string[],
  options: { shell: false; stdio: "inherit" },
) => SpawnedChild;

export interface FuseboxCliOptions {
  binaryPath?: string | null;
  spawn?: Spawn;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const COMMANDS = new Set([
  "init",
  "run",
  "proxy",
  "receipts",
  "why",
  "verify",
  "policy",
  "capabilities",
  "version",
]);

const HELP = `Fusebox — local agent execution gateway

Usage: fusebox <command> [options]

Commands:
  init       Initialize a workspace intent
  run        Run a supervised command
  proxy      Proxy an MCP server over stdio
  receipts   List execution receipts
  why        Explain a receipt
  verify     Verify a receipt chain
  policy     Inspect or evaluate policy
  version    Print version information
  --help     Show this help
`;

async function findBinary(cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const configured = env.FUSEBOX_BINARY;
  if (configured) return configured;

  const executable = process.platform === "win32" ? "fusebox.exe" : "fusebox";
  const candidates = [
    path.join(cwd, "rust", "target", "release", executable),
    path.join(cwd, "rust", "target", "debug", executable),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next development build location.
    }
  }
  return null;
}

export async function runFuseboxCli(
  args: string[],
  options: FuseboxCliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const command = args[0];

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    stdout(HELP);
    return 0;
  }

  if (!COMMANDS.has(command)) {
    stderr(`Unknown Fusebox command: ${command}\n\n${HELP}`);
    return 2;
  }

  const binaryPath = options.binaryPath !== undefined
    ? options.binaryPath
    : await findBinary(options.cwd ?? process.cwd(), options.env ?? process.env);
  if (!binaryPath) {
    stderr("Rust Fusebox executable was not found. Build it with `npm run rust:build` or set FUSEBOX_BINARY.\n");
    return 1;
  }

  const spawn = options.spawn ?? ((file, childArgs, spawnOptions) =>
    nodeSpawn(file, childArgs, spawnOptions));

  return await new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve(code);
    };

    try {
      const child = spawn(binaryPath, args, { shell: false, stdio: "inherit" });
      child.once("error", (error: Error) => {
        stderr(`Failed to start Fusebox: ${error.message}\n`);
        finish(1);
      });
      child.once("close", (code: number | null) => finish(code ?? 1));
    } catch (error) {
      stderr(`Failed to start Fusebox: ${error instanceof Error ? error.message : String(error)}\n`);
      finish(1);
    }
  });
}
