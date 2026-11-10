import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPORT_CONTEXT_MAX_TOKENS,
  ExportContextSchema,
  buildExportContext,
  estimateTokens,
  reorderLongContext,
  renderExportContextMarkdown,
  writeExportContext,
} from "../src/cli/exportContext.js";
import type { DiffResult } from "../src/engine/diff.js";
import type { AstExtract } from "../src/types/scan.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeSnapshot(entries: unknown[]): unknown {
  return {
    version: 2,
    generatedAt: "2026-01-01T00:00:00.000Z",
    targetDir: "/tmp/project",
    entries,
    warnings: [],
    metadata: { totalFiles: 2, totalModules: entries.length, languages: ["ts"] },
  };
}

function makeDiff(
  changes: Array<{ path: string; changeType: "ADDED" | "MODIFIED" | "REMOVED" | "UNTOUCHED" }>,
): DiffResult {
  const mapped = changes.map((change) => ({
    ...change,
    category: "utils" as const,
    previousState: undefined,
    currentState: undefined,
  }));
  return {
    changes: mapped,
    added: mapped.filter((change) => change.changeType === "ADDED"),
    modified: mapped.filter((change) => change.changeType === "MODIFIED"),
    removed: mapped.filter((change) => change.changeType === "REMOVED"),
    untouched: mapped.filter((change) => change.changeType === "UNTOUCHED"),
    byCategory: new Map(),
  } as DiffResult;
}

function makeExtract(
  file: string,
  exports: Array<{ name: string; line: number; kind: "function" | "class" | "const" | "type" | "default" }>,
  imports: string[] = [],
): AstExtract {
  return {
    file,
    exports: exports.map((exp) => ({ ...exp, column: 0 })),
    imports,
    signatures: [],
  };
}

const ENTRIES = [
  {
    id: "1",
    tech: "Function/Method: `login`",
    simple: "Function: login",
    ref: "[src/auth/login.ts:10:0]",
    category: "auth",
  },
  {
    id: "2",
    tech: "Class/Type: `Options`",
    simple: "Data structure or type: options",
    ref: "[src/utils/types.ts:4:0]",
    category: "utils",
  },
  {
    id: "3",
    tech: "Constant/Module: `MAX_SIZE`",
    simple: "Constant or config value: max size",
    ref: "[src/utils/constants.ts:1:0]",
    category: "utils",
  },
];

describe("export context", () => {
  it("keeps only valid refs and validates the output schema", () => {
    const payload = buildExportContext(
      makeSnapshot([
        ...ENTRIES,
        { id: "bad-ref", tech: "Function/Method: `bad`", simple: "bad", ref: "not-a-ref", category: "utils" },
        { id: "bad-category", tech: "Function/Method: `bad`", simple: "bad", ref: "[src/x.ts:1]", category: "nope" },
        { id: "empty-text", tech: "", simple: "", ref: "[src/y.ts:1]", category: "utils" },
      ]),
    );

    expect(ExportContextSchema.safeParse(payload).success).toBe(true);
    expect(payload.entries).toHaveLength(ENTRIES.length);
    expect(payload.entries.every((entry) => entry.ref.startsWith("["))).toBe(true);
  });

  it("is deterministic for the same inputs", () => {
    const first = buildExportContext(makeSnapshot(ENTRIES));
    const second = buildExportContext(makeSnapshot(ENTRIES));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("deduplicates repeated references instead of spending the budget twice", () => {
    const duplicate = {
      id: "duplicate",
      tech: "Function/Method: `login`",
      simple: "Function: login",
      ref: "[src/auth/login.ts:10:0]",
      category: "auth",
    };
    const payload = buildExportContext(
      makeSnapshot([ENTRIES[0]!, duplicate, ENTRIES[1]!]),
    );

    expect(payload.entries.filter((entry) => entry.ref === "[src/auth/login.ts:10:0]")).toHaveLength(1);
    expect(payload.entries).toHaveLength(2);
    expect(payload.budget.totalCandidates).toBe(2);
  });

  it("ranks changed auth exports above untouched utility exports", () => {
    const payload = buildExportContext(makeSnapshot(ENTRIES), {
      diffResult: makeDiff([
        { path: "src/auth/login.ts", changeType: "MODIFIED" },
        { path: "src/utils/types.ts", changeType: "UNTOUCHED" },
        { path: "src/utils/constants.ts", changeType: "UNTOUCHED" },
      ]),
    });

    expect(payload.entries[0]?.ref).toBe("[src/auth/login.ts:10:0]");
    expect(payload.entries[0]?.score).toBeGreaterThan(payload.entries[1]?.score ?? 0);
  });

  it("uses dependent counts when extracts are supplied", () => {
    const payload = buildExportContext(
      makeSnapshot([
        {
          id: "shared",
          tech: "Function/Method: `shared`",
          simple: "Function: shared",
          ref: "[src/utils/shared.ts:1:0]",
          category: "utils",
        },
        {
          id: "lonely",
          tech: "Function/Method: `lonely`",
          simple: "Function: lonely",
          ref: "[src/utils/lonely.ts:1:0]",
          category: "utils",
        },
      ]),
      {
        extracts: [
          makeExtract("src/utils/shared.ts", [{ name: "shared", line: 1, kind: "function" }]),
          makeExtract("src/utils/lonely.ts", [{ name: "lonely", line: 1, kind: "function" }]),
          makeExtract("src/a.ts", [], ["./utils/shared"]),
          makeExtract("src/b.ts", [], ["./utils/shared"]),
        ],
        weights: {
          category: 0,
          changeSize: 0,
          exportChange: 0,
          recency: 0,
          dependents: 1,
        },
      },
    );

    expect(payload.entries[0]?.ref).toBe("[src/utils/shared.ts:1:0]");
  });

  it("enforces the token budget and marks truncation", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      id: String(index),
      tech: `Function/Method: \`fn${index}\``,
      simple: `Function: fn${index}`,
      ref: `[src/utils/f${index}.ts:1:0]`,
      category: "utils",
    }));

    const payload = buildExportContext(makeSnapshot(many), { maxTokens: 400 });

    expect(payload.entries.length).toBeLessThan(many.length);
    expect(payload.budget.truncated).toBe(true);
    expect(payload.budget.totalCandidates).toBe(many.length);
    expect(payload.budget.estimatedTokens).toBeLessThanOrEqual(400);
    expect(estimateTokens(JSON.stringify(payload, null, 2))).toBe(payload.budget.estimatedTokens);
  });

  it("fails fast when the budget cannot fit mandatory metadata", () => {
    expect(() => buildExportContext(makeSnapshot(ENTRIES), { maxTokens: 10 })).toThrow(
      /too small/,
    );
  });

  it("supports a simple audience without tech labels", () => {
    const payload = buildExportContext(makeSnapshot(ENTRIES), { audience: "simple" });

    expect(payload.audience).toBe("simple");
    expect(payload.entries.every((entry) => entry.simple !== undefined)).toBe(true);
    expect(payload.entries.every((entry) => entry.tech === undefined)).toBe(true);
  });

  it("renders deterministic markdown with refs and the verified-facts legend", () => {
    const payload = buildExportContext(makeSnapshot(ENTRIES));
    const markdown = renderExportContextMarkdown(payload);

    expect(markdown).toContain("# Memo-log AI Context Pack");
    expect(markdown).toContain("Verified facts only");
    expect(markdown).toContain("[src/auth/login.ts:10:0]");
    expect(markdown).not.toContain("generatedAt");
    expect(renderExportContextMarkdown(payload)).toBe(markdown);
  });

  it("writes JSON and optional markdown atomically", async () => {
    const root = await tempDir("memolog-export-context-");
    const result = writeExportContext(root, undefined, makeSnapshot(ENTRIES), { markdown: true });

    const json = await fs.readFile(result.jsonPath, "utf8");
    const markdown = await fs.readFile(result.markdownPath!, "utf8");

    expect(JSON.parse(json).kind).toBe("memo-log-export-context");
    expect(markdown).toContain("Ranked facts");
    expect(result.markdownPath).toBe(path.join(root, "MEMO_LOG_CONTEXT.md"));
  });

  it("defaults to the 1M config ceiling and reports the ordering", () => {
    const payload = buildExportContext(makeSnapshot(ENTRIES));

    expect(DEFAULT_EXPORT_CONTEXT_MAX_TOKENS).toBe(1_000_000);
    expect(payload.budget.maxTokens).toBe(1_000_000);
    expect(payload.budget.truncated).toBe(false);
    expect(payload.ordering).toBe("long-context-reorder");
    expect(payload.schema).toBe(2);
  });

  it("reorders deterministically so top facts bracket the pack", () => {
    expect(reorderLongContext(["a", "b", "c", "d", "e"])).toEqual([
      "a",
      "c",
      "e",
      "d",
      "b",
    ]);

    const entries = [
      { ref: "[src/auth/a.ts:1:0]", category: "auth" as const, tech: "Function/Method: `a`", simple: "a" },
      { ref: "[src/api/b.ts:1:0]", category: "api" as const, tech: "Function/Method: `b`", simple: "b" },
      { ref: "[src/components/c.tsx:1:0]", category: "components" as const, tech: "Function/Method: `c`", simple: "c" },
      { ref: "[src/utils/d.ts:1:0]", category: "utils" as const, tech: "Function/Method: `d`", simple: "d" },
    ];

    const payload = buildExportContext(makeSnapshot(entries), {
      weights: { changeSize: 0, exportChange: 0, category: 1, recency: 0, dependents: 0 },
    });

    expect(payload.entries.map((entry) => entry.category)).toEqual([
      "auth",
      "components",
      "utils",
      "api",
    ]);
    expect(payload.entries[0]?.category).toBe("auth");
    expect(payload.entries.at(-1)?.category).toBe("api");
  });

  it("can disable reordering", () => {
    const payload = buildExportContext(makeSnapshot(ENTRIES), { reorder: false });

    expect(payload.ordering).toBe("ranked");
    const scores = payload.entries.map((entry) => entry.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("includes reference-only conflicting facts and omits unverifiable ones", () => {
    const payload = buildExportContext(makeSnapshot(ENTRIES), {
      conflicts: [
        {
          exportName: "login",
          filePath: "src/auth/login.ts",
          severity: "HIGH",
          agentARef: "[src/auth/login.ts:10]",
          agentBRef: "[src/auth/login.ts:12]",
          message: "CONFLICT: export \"login\" has different signatures.",
        },
        {
          exportName: "ignored",
          filePath: "src/utils/types.ts",
          severity: "INFO",
          agentARef: "[src/utils/types.ts:4]",
          agentBRef: "[src/utils/types.ts:5]",
          message: "INFO: informational only.",
        },
        {
          exportName: "missing",
          filePath: "src/utils/missing.ts",
          severity: "MEDIUM",
          agentARef: "[missing]",
          agentBRef: "[missing]",
          message: "CONFLICT: no verifiable location.",
        },
      ],
    });

    expect(payload.conflicts).toHaveLength(1);
    expect(payload.conflicts[0]).toMatchObject({
      severity: "HIGH",
      exportName: "login",
      refs: ["[src/auth/login.ts:10]", "[src/auth/login.ts:12]"],
    });

    const markdown = renderExportContextMarkdown(payload);
    expect(markdown).toContain("## Conflicting facts");
    expect(markdown).toContain("different signatures");
    expect(markdown).not.toContain("informational only");
    expect(markdown).not.toContain("no verifiable location");
  });

  it("keeps the conflict block inside the token budget", () => {
    const payload = buildExportContext(makeSnapshot(ENTRIES), {
      maxTokens: 500,
      conflicts: [
        {
          exportName: "login",
          filePath: "src/auth/login.ts",
          severity: "HIGH",
          agentARef: "[src/auth/login.ts:10]",
          agentBRef: "[src/auth/login.ts:12]",
          message: "CONFLICT: export \"login\" has different signatures.",
        },
      ],
    });

    expect(payload.budget.estimatedTokens).toBeLessThanOrEqual(500);
    expect(estimateTokens(JSON.stringify(payload, null, 2))).toBe(payload.budget.estimatedTokens);
  });
});
