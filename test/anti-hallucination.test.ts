import { describe, it, expect } from "vitest";
import {
  validateOutput,
  isValidFileRef,
  extractFilePathFromRef,
  createFileRef,
  runAntiFakeChecklist,
  auditLog,
} from "../src/engine/anti-hallucination.js";
import type { MemorySnapshot, MemoryEntry } from "../src/engine/anti-hallucination.js";
import { CliError, ExitCode } from "../src/engine/errors.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    tech: "Exported function formatDate",
    simple: "A function that formats dates",
    ref: "[src/utils/date.ts:10]",
    category: "utils",
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<MemorySnapshot> = {}): MemorySnapshot {
  return {
    version: 2,
    generatedAt: "2026-04-25T12:00:00.000Z",
    targetDir: "/project",
    entries: [makeEntry()],
    warnings: [],
    ...overrides,
  };
}

describe("anti-hallucination engine", () => {
  describe("validateOutput", () => {
    it("should pass a valid snapshot", () => {
      const snapshot = makeSnapshot();
      const result = validateOutput(snapshot, "/project");
      expect(result.version).toBe(2);
      expect(result.entries.length).toBe(1);
    });

    it("should reject schema violation — wrong version", () => {
      const snapshot = makeSnapshot({ version: 1 as unknown as 2 });
      expect(() => validateOutput(snapshot, "/project")).toThrow(CliError);
    });

    it("should reject schema violation — missing entries field", () => {
      const snapshot = { ...makeSnapshot() };
      const bad = { ...snapshot, entries: undefined } as unknown as MemorySnapshot;
      expect(() => validateOutput(bad, "/project")).toThrow(CliError);
    });

    it("should reject schema violation — invalid category", () => {
      const snapshot = makeSnapshot({
        entries: [makeEntry({ category: "invalid" as unknown as "utils" })],
      });
      expect(() => validateOutput(snapshot, "/project")).toThrow(CliError);
    });

    it("should reject schema violation — invalid UUID", () => {
      const snapshot = makeSnapshot({
        entries: [makeEntry({ id: "not-a-uuid" })],
      });
      expect(() => validateOutput(snapshot, "/project")).toThrow(CliError);
    });

    it("should reject empty tech string via runtime check", () => {
      const snapshot = makeSnapshot({
        entries: [makeEntry({ tech: "   " })],
      });
      expect(() => validateOutput(snapshot, "/project")).toThrow(CliError);
    });

    it("should reject empty simple string via runtime check", () => {
      const snapshot = makeSnapshot({
        entries: [makeEntry({ simple: "   " })],
      });
      expect(() => validateOutput(snapshot, "/project")).toThrow(CliError);
    });

    it("should include RuntimeError exit code on failure", () => {
      try {
        validateOutput({ version: 1 } as unknown as MemorySnapshot, "/project");
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).exitCode).toBe(ExitCode.RuntimeError);
      }
    });
  });

  describe("isValidFileRef", () => {
    it("should accept valid [file:line] ref", () => {
      expect(isValidFileRef("[src/utils.ts:10]")).toBe(true);
    });

    it("should accept valid [file:line:col] ref", () => {
      expect(isValidFileRef("[src/utils.ts:10:5]")).toBe(true);
    });

    it("should accept nested paths", () => {
      expect(isValidFileRef("[src/deep/nested/file.ts:42]")).toBe(true);
    });

    it("should reject ref without brackets", () => {
      expect(isValidFileRef("src/utils.ts:10")).toBe(false);
    });

    it("should reject ref without line number", () => {
      expect(isValidFileRef("[src/utils.ts]")).toBe(false);
    });

    it("should reject empty string", () => {
      expect(isValidFileRef("")).toBe(false);
    });

    it("should reject ref with non-numeric line", () => {
      expect(isValidFileRef("[src/utils.ts:abc]")).toBe(false);
    });

    it("should reject ref missing closing bracket", () => {
      expect(isValidFileRef("[src/utils.ts:10")).toBe(false);
    });

    it("should reject ref with spaces inside", () => {
      expect(isValidFileRef("[ src/utils.ts :10 ]")).toBe(false);
    });
  });

  describe("extractFilePathFromRef", () => {
    it("should extract file path from [file:line]", () => {
      expect(extractFilePathFromRef("[src/utils.ts:10]")).toBe("src/utils.ts");
    });

    it("should extract file path from [file:line:col]", () => {
      expect(extractFilePathFromRef("[src/utils.ts:10:5]")).toBe("src/utils.ts");
    });

    it("should extract nested path", () => {
      expect(extractFilePathFromRef("[src/deep/nested/mod.ts:42]")).toBe("src/deep/nested/mod.ts");
    });

    it("should return null for invalid ref", () => {
      expect(extractFilePathFromRef("invalid")).toBeNull();
    });

    it("should return null for empty string", () => {
      expect(extractFilePathFromRef("")).toBeNull();
    });

    it("should return null for ref without line number", () => {
      expect(extractFilePathFromRef("[src/utils.ts]")).toBeNull();
    });
  });

  describe("createFileRef", () => {
    it("should format ref with line only", () => {
      expect(createFileRef("src/utils.ts", 10)).toBe("[src/utils.ts:10]");
    });

    it("should format ref with line and column", () => {
      expect(createFileRef("src/utils.ts", 10, 5)).toBe("[src/utils.ts:10:5]");
    });

    it("should handle deep paths", () => {
      expect(createFileRef("src/deep/nested/mod.ts", 42)).toBe("[src/deep/nested/mod.ts:42]");
    });

    it("should produce valid ref that passes isValidFileRef", () => {
      expect(isValidFileRef(createFileRef("src/app.ts", 1))).toBe(true);
      expect(isValidFileRef(createFileRef("src/app.ts", 1, 1))).toBe(true);
    });
  });

  describe("runAntiFakeChecklist", () => {
    it("should return no violations for valid snapshot", () => {
      const snapshot = makeSnapshot();
      const violations = runAntiFakeChecklist(snapshot);
      expect(violations).toEqual([]);
    });

    it("should detect empty entry list", () => {
      const snapshot = makeSnapshot({ entries: [] });
      const violations = runAntiFakeChecklist(snapshot);
      expect(violations).toContain("WARN: Empty entry list");
    });

    it("should detect invalid ref format", () => {
      const snapshot = makeSnapshot({
        entries: [makeEntry({ ref: "invalid-ref" })],
      });
      const violations = runAntiFakeChecklist(snapshot);
      expect(violations).toEqual(
        expect.arrayContaining([expect.stringContaining("VIOLATION: Invalid ref format")])
      );
    });

    it("should detect identical tech and simple descriptions", () => {
      const snapshot = makeSnapshot({
        entries: [makeEntry({ tech: "Same text", simple: "Same text" })],
      });
      const violations = runAntiFakeChecklist(snapshot);
      expect(violations).toEqual(
        expect.arrayContaining([expect.stringContaining("WARN: Tech and simple descriptions are identical")])
      );
    });

    it("should detect invalid timestamp format", () => {
      const snapshot = makeSnapshot({ generatedAt: "not-a-timestamp" });
      const violations = runAntiFakeChecklist(snapshot);
      expect(violations).toContain("VIOLATION: Invalid timestamp format");
    });

    it("should return multiple violations for multiple issues", () => {
      const snapshot = makeSnapshot({
        generatedAt: "bad",
        entries: [makeEntry({ tech: "same", simple: "same", ref: "bad" })],
      });
      const violations = runAntiFakeChecklist(snapshot);
      expect(violations.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("auditLog", () => {
    it("should return message for empty entries", () => {
      expect(auditLog([])).toBe("No entries to audit.");
    });

    it("should include total entry count", () => {
      const entries = [makeEntry()];
      const log = auditLog(entries);
      expect(log).toContain("Total entries: 1");
    });

    it("should include header", () => {
      const entries = [makeEntry()];
      const log = auditLog(entries);
      expect(log).toContain("Anti-Hallucination Audit Log");
    });

    it("should include category section", () => {
      const entries = [makeEntry({ category: "utils" })];
      const log = auditLog(entries);
      expect(log).toContain("[UTILS]");
    });

    it("should include entry refs", () => {
      const entries = [makeEntry({ ref: "[src/app.ts:5]" })];
      const log = auditLog(entries);
      expect(log).toContain("[src/app.ts:5]");
    });

    it("should include tech and simple descriptions", () => {
      const entries = [makeEntry({ tech: "My tech desc", simple: "My simple desc" })];
      const log = auditLog(entries);
      expect(log).toContain('tech: "My tech desc"');
      expect(log).toContain('simple: "My simple desc"');
    });

    it("should truncate long descriptions over 60 chars", () => {
      const longTech = "A".repeat(70);
      const longSimple = "B".repeat(70);
      const entries = [makeEntry({ tech: longTech, simple: longSimple })];
      const log = auditLog(entries);
      expect(log).toContain("A".repeat(60) + "...");
      expect(log).toContain("B".repeat(60) + "...");
    });

    it("should group entries by category", () => {
      const entries = [
        makeEntry({ id: "11111111-1111-1111-1111-111111111111", category: "utils" }),
        makeEntry({ id: "22222222-2222-2222-2222-222222222222", category: "auth" }),
        makeEntry({ id: "33333333-3333-3333-3333-333333333333", category: "utils" }),
      ];
      const log = auditLog(entries);
      expect(log).toContain("[UTILS] 2 entries:");
      expect(log).toContain("[AUTH] 1 entries:");
    });

    it("should include compliance guarantees", () => {
      const entries = [makeEntry()];
      const log = auditLog(entries);
      expect(log).toContain("✓ Every entry has verifiable [file:line] reference");
      expect(log).toContain("✓ Schema version: 2");
    });
  });
});
