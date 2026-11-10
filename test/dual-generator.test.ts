import { describe, it, expect } from "vitest";
import {
  generateDualOutput,
  renderMarkdown,
  renderBriefMode,
} from "../src/output/dual-generator.js";
import type { AstExtract } from "../src/types/scan.js";

function makeExtract(overrides: Partial<AstExtract> & { file: string }): AstExtract {
  return {
    exports: [],
    imports: [],
    signatures: [],
    ...overrides,
  };
}

const sampleExtracts: AstExtract[] = [
  makeExtract({
    file: "src/components/Button.tsx",
    exports: [
      { kind: "function", name: "Button", line: 5, column: 0 },
      { kind: "function", name: "IconButton", line: 12 },
    ],
  }),
  makeExtract({
    file: "src/auth/login.ts",
    exports: [
      { kind: "function", name: "login", line: 10 },
      { kind: "function", name: "handleLogout", line: 25 },
    ],
  }),
  makeExtract({
    file: "src/utils/format.ts",
    exports: [
      { kind: "function", name: "getDateString", line: 3 },
      { kind: "function", name: "isValid", line: 15 },
      { kind: "function", name: "_internalHelper", line: 20 },
      { kind: "function", name: "x", line: 30 },
    ],
  }),
];

describe("dual-generator", () => {
  describe("generateDualOutput", () => {
    it("should produce valid MemorySnapshot with entries for given AstExtract inputs", () => {
      const snapshot = generateDualOutput(sampleExtracts, "dual");

      expect(snapshot.version).toBe(2);
      expect(snapshot.generatedAt).toBeTruthy();
      expect(snapshot.entries.length).toBeGreaterThan(0);
      expect(snapshot.metadata?.totalFiles).toBe(3);
      expect(snapshot.metadata?.totalModules).toBe(8);
      expect(snapshot.warnings).toEqual([]);
    });

    it("should sort entries by file path", () => {
      const outOfOrder: AstExtract[] = [
        makeExtract({
          file: "src/utils/zoo.ts",
          exports: [{ kind: "function", name: "zoo", line: 1 }],
        }),
        makeExtract({
          file: "src/auth/login.ts",
          exports: [{ kind: "function", name: "login", line: 1 }],
        }),
        makeExtract({
          file: "src/api/routes.ts",
          exports: [{ kind: "function", name: "routes", line: 1 }],
        }),
      ];

      const snapshot = generateDualOutput(outOfOrder, "tech");
      const refs = snapshot.entries.map((e) => e.ref);

      const paths = refs.map((r) => r.match(/^\[(.+?):\d+/)?.[1] ?? "");
      const sorted = [...paths].sort((a, b) => a.localeCompare(b));
      expect(paths).toEqual(sorted);
    });

    it("should skip exports starting with _ or shorter than 2 chars", () => {
      const snapshot = generateDualOutput(sampleExtracts, "dual");

      for (const entry of snapshot.entries) {
        const name = entry.tech.match(/`([^`]+)`/)?.[1] ?? "";
        expect(name.startsWith("_")).toBe(false);
        expect(name.length).toBeGreaterThanOrEqual(2);
      }

      expect(snapshot.entries.length).toBe(6);
      expect(snapshot.metadata?.totalModules).toBe(8);
    });

    it("should categorize entries correctly", () => {
      const snapshot = generateDualOutput(sampleExtracts, "dual");

      const categories = snapshot.entries.map((e) => e.category);
      const authEntries = categories.filter((c) => c === "auth");
      const componentEntries = categories.filter((c) => c === "components");
      const utilEntries = categories.filter((c) => c === "utils");

      expect(authEntries.length).toBe(2);
      expect(componentEntries.length).toBe(2);
      expect(utilEntries.length).toBe(2);
    });

    it("should humanize export names", () => {
      const extracts: AstExtract[] = [
        makeExtract({
          file: "src/utils/format.ts",
          exports: [{ kind: "function", name: "getDateString", line: 1 }],
        }),
        makeExtract({
          file: "src/utils/validate.ts",
          exports: [{ kind: "function", name: "isValidEmail", line: 1 }],
        }),
        makeExtract({
          file: "src/utils/handler.ts",
          exports: [{ kind: "function", name: "handleSubmit", line: 1 }],
        }),
      ];

      const snapshot = generateDualOutput(extracts, "dual");

      expect(snapshot.entries[0]!.simple).toContain("date string");
      expect(snapshot.entries[1]!.simple).toContain("submit");
      expect(snapshot.entries[2]!.simple).toContain("valid email");
    });
  });

  describe("renderMarkdown", () => {
    it("should produce markdown with Engineering Ledger in tech mode", () => {
      const snapshot = generateDualOutput(sampleExtracts, "tech");
      const md = renderMarkdown(snapshot, "tech");

      expect(md).toContain("## Engineering Ledger (Technical)");
      expect(md).not.toContain("## Executive Brief");
      expect(md).toContain("`Button`");
    });

    it("should produce markdown with Executive Brief in simple mode", () => {
      const snapshot = generateDualOutput(sampleExtracts, "simple");
      const md = renderMarkdown(snapshot, "simple");

      expect(md).toContain("## Executive Brief (Non-Technical)");
      expect(md).not.toContain("## Engineering Ledger");
      expect(md).toContain("Screen UI & layout blocks");
    });

    it("should produce both sections in dual mode", () => {
      const snapshot = generateDualOutput(sampleExtracts, "dual");
      const md = renderMarkdown(snapshot, "dual");

      expect(md).toContain("## Executive Brief (Non-Technical)");
      expect(md).toContain("## Engineering Ledger (Technical)");
    });
  });

  describe("renderBriefMode", () => {
    it("should produce brief output with summary counts", () => {
      const snapshot = generateDualOutput(sampleExtracts, "dual");
      const brief = renderBriefMode(snapshot);

      expect(brief).toContain("# Project Brief");
      expect(brief).toContain("## Summary");
      expect(brief).toContain("**Total features:**");
      expect(brief).toContain("**Auth flows:**");
      expect(brief).toContain("**UI components:**");
      expect(brief).toContain("## What's Changed (Plain English)");
    });

    it("should not include test entries in counts", () => {
      const withTest: AstExtract[] = [
        ...sampleExtracts,
        makeExtract({
          file: "src/tests/login.test.ts",
          exports: [{ kind: "function", name: "loginTest", line: 1 }],
        }),
      ];

      const snapshot = generateDualOutput(withTest, "dual");
      const brief = renderBriefMode(snapshot);

      const totalMatch = brief.match(/\*\*Total features:\*\*\s*(\d+)/);
      const testEntry = snapshot.entries.find((e) => e.category === "test");
      expect(testEntry).toBeTruthy();
      expect(totalMatch).toBeTruthy();

      const nonTestCount = snapshot.entries.filter((e) => e.category !== "test").length;
      expect(Number(totalMatch![1])).toBe(nonTestCount);
    });
  });
});
