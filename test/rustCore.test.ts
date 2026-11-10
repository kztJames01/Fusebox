import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  detectBreakingChanges,
  buildCurrentState,
} from "../src/engine/diff.js";
import {
  detectBreakingChangesWithRust,
  findRustCoreBinary,
  getRustCoreInfo,
  runRustCore,
  rustRank,
  rustStructuralDiff,
  rustWalk,
  WalkOutputSchema,
} from "../src/engine/rustCore.js";
import { CliError } from "../src/engine/errors.js";
import { scoreEntryImpact, type ImpactKind } from "../src/engine/impactRanking.js";
import type { AstExtract } from "../src/types/scan.js";

const repoRoot = process.cwd();
const debugBinary = path.join(repoRoot, "rust", "target", "debug", "memolog-core");
const releaseBinary = path.join(repoRoot, "rust", "target", "release", "memolog-core");
const binary = existsSync(debugBinary) ? debugBinary : releaseBinary;
const hasBinary = existsSync(binary);
const requireRust = process.env["MEMOLOG_REQUIRE_RUST"] === "1";

if (!hasBinary) {
  const message =
    "Rust core integration tests are SKIPPED because no memolog-core binary was found. " +
    "Build it with `npm run rust:build`, or set MEMOLOG_REQUIRE_RUST=1 to fail instead.";
  if (requireRust) {
    throw new Error(message);
  }
  console.warn(`WARN: ${message}`);
}

const options = {
  mode: "auto" as const,
  cwd: repoRoot,
  env: {
    ...process.env,
    MEMO_LOG_RUST_CORE: binary,
  },
};

describe("Rust core discovery", () => {
  it("never discovers a binary when mode is off", () => {
    expect(findRustCoreBinary({ mode: "off", cwd: repoRoot })).toBeNull();
    expect(getRustCoreInfo({ mode: "off", cwd: repoRoot })).toEqual({
      mode: "off",
      available: false,
    });
  });

  it("uses an explicit MEMO_LOG_RUST_CORE path", () => {
    const info = getRustCoreInfo(options);
    expect(info.mode).toBe("auto");
    expect(info.available).toBe(hasBinary);
    if (hasBinary) {
      expect(info.binary).toBe(binary);
    }
  });

  it("fails fast in required mode when no binary exists", () => {
    expect(() =>
      runRustCore(
        { op: "version" },
        WalkOutputSchema,
        {
          mode: "required",
          cwd: repoRoot,
          env: { ...process.env, MEMO_LOG_RUST_CORE: "", MEMO_LOG_RUST_CORE_PATH: "" },
        },
      ),
    ).toThrow(CliError);
  });
});

describe.skipIf(!hasBinary)("Rust core integration", () => {
  it("walks a fixture deterministically with SHA-256 hashes", () => {
    const fixture = path.resolve(repoRoot, "test", "fixtures", "multi-lang");
    const first = rustWalk({ root: fixture, hash: true }, options);
    const second = rustWalk({ root: fixture, hash: true }, options);

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(first?.files.map((file) => file.path)).toEqual([
      "auth/login.go",
      "auth/login.py",
      "auth/login.rs",
      "utils/format.ts",
    ]);
    expect(first?.files.every((file) => /^[0-9a-f]{64}$/.test(file.hash ?? ""))).toBe(true);
    expect(first?.warnings).toEqual([]);
  });

  it("computes structural diffs compatible with the TypeScript fallback", () => {
    const before: AstExtract[] = [
      {
        file: "src/auth.ts",
        exports: [
          { name: "login", kind: "function", line: 3, signature: "function login(email)" },
          { name: "logout", kind: "function", line: 7, signature: "function logout()" },
        ],
        imports: [],
        signatures: ["function login(email)", "function logout()"],
      },
    ];
    const after: AstExtract[] = [
      {
        file: "src/auth.ts",
        exports: [
          {
            name: "login",
            kind: "function",
            line: 3,
            signature: "function login(email, password)",
          },
        ],
        imports: [],
        signatures: ["function login(email, password)"],
      },
    ];

    const previousState = buildCurrentState(before);
    const output = rustStructuralDiff(previousState, after, options);
    expect(output).not.toBeNull();
    expect(output?.breakingChanges.map((change) => change.kind).sort()).toEqual([
      "EXPORT_REMOVED",
      "SIGNATURE_CHANGED",
    ]);

    const viaRust = detectBreakingChangesWithRust(previousState, after, options);
    const viaTypeScript = detectBreakingChanges(previousState, after);
    expect(viaRust).toEqual(viaTypeScript);
  });

  it("ranks entries deterministically", () => {
    const entries = [
      {
        ref: "[src/utils/clip.ts:1]",
        category: "utils",
        kind: "function",
        changeType: "UNTOUCHED",
        entriesInFile: 1,
        maxEntriesInFile: 4,
        dependentCount: 0,
        maxDependentCount: 2,
      },
      {
        ref: "[src/auth/login.ts:1]",
        category: "auth",
        kind: "function",
        changeType: "MODIFIED",
        entriesInFile: 4,
        maxEntriesInFile: 4,
        dependentCount: 2,
        maxDependentCount: 2,
      },
    ];

    const first = rustRank(entries, undefined, options);
    const second = rustRank(entries, undefined, options);
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(first?.ranked[0]?.ref).toBe("[src/auth/login.ts:1]");
    expect(first?.ranked.every((entry) => entry.score >= 0 && entry.score <= 1)).toBe(true);

    // Rust and TypeScript must agree on every score, not just the ordering.
    for (const entry of entries) {
      const expected = scoreEntryImpact(
        { ref: entry.ref, category: entry.category, tech: "`symbol`" },
        {
          changeType: entry.changeType as "ADDED" | "MODIFIED" | "REMOVED" | "UNTOUCHED",
          entriesInFile: entry.entriesInFile,
          maxEntriesInFile: entry.maxEntriesInFile,
          dependentCount: entry.dependentCount,
          maxDependentCount: entry.maxDependentCount,
          kind: entry.kind as ImpactKind,
        },
      ).total;
      const actual = first?.ranked.find((ranked) => ranked.ref === entry.ref)?.score;
      expect(actual).toBe(expected);
    }
  });
});
