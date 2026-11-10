// Performance microbenchmarks for runtime inference and conflict detection.
// Target: inference <2s.

import { describe, it, expect } from "vitest";
import { inferRuntimeBehavior } from "../src/engine/runtimeInference.js";
import { detectConflicts } from "../src/ui/agent-ui/conflicts.js";
import type { ParsedFile } from "../src/parsers/types.js";

function makeParsedFile(overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path: "src/test.ts",
    lang: "ts" as const,
    contentHash: "abc",
    exports: [],
    imports: [],
    signatures: [],
    usedFallback: false,
    warnings: [],
    ...overrides,
  };
}

describe("runtime inference performance (<2s)", () => {
  it("infers 300-line file well under 2s", () => {
    const content = Array.from({ length: 300 }, (_, i) =>
      `export function fn${i}(x: string) { return processItem(x); }`
    ).join("\n");

    const file = makeParsedFile({
      exports: Array.from({ length: 300 }, (_, i) => ({
        name: `fn${i}`, kind: "function" as const, line: i + 1, column: 0,
      })),
    });

    const start = performance.now();
    const result = inferRuntimeBehavior(file, content, { timeoutMs: 2000 });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(2000);
    expect(result).toBeDefined();
  });
});

describe("conflict detection performance", () => {
  it("detects conflicts across 100 files with 20 exports each in <500ms", () => {
    const files: ParsedFile[] = Array.from({ length: 100 }, (_, fi) =>
      makeParsedFile({
        path: `src/module${fi}.ts`,
        exports: Array.from({ length: 20 }, (_, ei) => ({
          name: `export${ei}`, kind: "function" as const, line: ei + 1, column: 0,
        })),
        signatures: Array.from({ length: 20 }, (_, ei) => ({
          name: `export${ei}`,
          signature: `function export${ei}(a, b)`,
          line: ei + 1,
          column: 0,
          async: false,
          generator: false,
          params: ["a", "b"],
        })),
      })
    );

    // Slightly modify half the signatures for agent B
    const filesB: ParsedFile[] = files.map((f, fi) => ({
      ...f,
      signatures: f.signatures.map((s, si) => ({
        ...s,
        signature: fi % 3 === 0 && si % 5 === 0
          ? `function ${s.name}(x: string)` // different sig — triggers HIGH conflict
          : s.signature,
      })),
    }));

    const start = performance.now();
    const report = detectConflicts(files, filesB);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(report).toBeDefined();
    expect(report.hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
