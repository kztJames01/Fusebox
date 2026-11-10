// Deterministic benchmark: Node walker + SHA-256 vs the Rust core.
//
// Usage:
//   npm run benchmark:rust -- [targetDir] [iterations]
//
// The script verifies that both implementations see the same files and hashes
// before reporting timings, so a speedup can never come from doing less work.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { walkDirectory } from "../src/security/index.js";
import { findRustCoreBinary, rustWalk } from "../src/engine/rustCore.js";

interface HashResult {
  files: Map<string, string>;
  elapsedMs: number;
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

async function hashWithNode(rootDir: string): Promise<HashResult> {
  const started = nowMs();
  const manifest = await walkDirectory({
    rootPath: rootDir,
    maxDepth: 64,
    timeoutMs: 120_000,
    maxFileSizeBytes: 2 * 1024 * 1024,
  });

  const hashes = new Map<string, string>();
  await Promise.all(
    manifest.entries.map(async (entry) => {
      const bytes = await readFile(entry.absolutePath);
      const hash = createHash("sha256").update(bytes).digest("hex");
      hashes.set(entry.relativePath.replace(/\\/g, "/"), hash);
    }),
  );

  return { files: hashes, elapsedMs: nowMs() - started };
}

function hashWithRust(rootDir: string, binary: string): HashResult {
  const started = nowMs();
  const output = rustWalk(
    { root: rootDir, maxDepth: 64, maxFileSizeBytes: 2 * 1024 * 1024, hash: true },
    {
      mode: "required",
      cwd: process.cwd(),
      env: { ...process.env, MEMO_LOG_RUST_CORE: binary },
      timeoutMs: 120_000,
    },
  );

  if (output === null) {
    throw new Error("Rust core returned no output");
  }

  const hashes = new Map<string, string>();
  for (const file of output.files) {
    if (file.hash === undefined) {
      throw new Error(`Rust core did not hash ${file.path}`);
    }
    hashes.set(file.path, file.hash);
  }
  return { files: hashes, elapsedMs: nowMs() - started };
}

function assertParity(node: Map<string, string>, rust: Map<string, string>): void {
  const nodePaths = [...node.keys()].sort();
  const rustPaths = [...rust.keys()].sort();

  if (nodePaths.length !== rustPaths.length) {
    throw new Error(
      `File count mismatch: Node=${nodePaths.length} Rust=${rustPaths.length}`,
    );
  }

  for (let index = 0; index < nodePaths.length; index += 1) {
    if (nodePaths[index] !== rustPaths[index]) {
      throw new Error(
        `Path mismatch at ${index}: Node=${nodePaths[index]} Rust=${rustPaths[index]}`,
      );
    }
  }

  for (const file of nodePaths) {
    if (node.get(file) !== rust.get(file)) {
      throw new Error(`Hash mismatch for ${file}`);
    }
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  }
  return sorted[middle] ?? 0;
}

async function main(): Promise<void> {
  const targetDir = path.resolve(process.argv[2] ?? process.cwd());
  const iterations = Math.max(1, Number(process.argv[3] ?? 5));
  if (!Number.isFinite(iterations)) {
    throw new Error("iterations must be a number");
  }

  const binary =
    process.env.MEMO_LOG_RUST_CORE ??
    findRustCoreBinary({
      mode: "auto",
      cwd: process.cwd(),
      env: { ...process.env, MEMO_LOG_RUST_CORE_DEV: "1" },
    });

  if (binary === null || !existsSync(binary)) {
    throw new Error(
      "Rust core binary not found. Run `cargo build --release --manifest-path rust/Cargo.toml` " +
        "or set MEMO_LOG_RUST_CORE.",
    );
  }

  // Warm both paths so file-system caches do not bias the first sample.
  const warmNode = await hashWithNode(targetDir);
  const warmRust = hashWithRust(targetDir, binary);
  assertParity(warmNode.files, warmRust.files);

  const nodeTimes: number[] = [];
  const rustTimes: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const node = await hashWithNode(targetDir);
    const rust = hashWithRust(targetDir, binary);
    assertParity(node.files, rust.files);
    nodeTimes.push(node.elapsedMs);
    rustTimes.push(rust.elapsedMs);
  }

  const nodeMedian = median(nodeTimes);
  const rustMedian = median(rustTimes);
  const speedup = rustMedian > 0 ? nodeMedian / rustMedian : Number.POSITIVE_INFINITY;

  console.log(`Target: ${targetDir}`);
  console.log(`Files: ${warmNode.files.size}`);
  console.log(`Iterations: ${iterations}`);
  console.log(`Node (walk + SHA-256): ${nodeMedian.toFixed(2)} ms (median)`);
  console.log(`Rust (walk + SHA-256): ${rustMedian.toFixed(2)} ms (median)`);
  console.log(`Speedup: ${speedup.toFixed(2)}x`);
  console.log("Parity: OK (same paths and hashes)");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
