import { describe, it, expect, beforeEach } from "vitest";
import {
  diffStates,
  buildCurrentState,
  loadState,
  saveState,
  computeFileState,
  getDiffSummary,
  validateNoStaleReferences,
  clearState,
  STATE_DIR
} from "../src/engine/diff.js";
import type { AstExtract } from "../src/types/scan.js";
import type { StateV2 } from "../src/engine/diff.js";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

describe("diff engine", () => {
  const testDir = join(process.cwd(), ".test-diff");
  const stateDirPath = join(testDir, STATE_DIR);
  const stateFilePath = join(stateDirPath, "state.json");

  beforeEach(() => {
    try {
      mkdirSync(stateDirPath, { recursive: true });
      if (existsSync(stateFilePath)) {
        unlinkSync(stateFilePath);
      }
    } catch {
      // ignore
    }
  });

  describe("computeFileState", () => {
    it("should produce consistent hash for same extract", () => {
      const extract: AstExtract = {
        file: "src/utils/helper.ts",
        exports: [{ kind: "function", name: "formatDate", line: 1, column: 0 }],
        imports: ["./constants"],
        signatures: ["function formatDate(date: Date): string"],
      };

      const state1 = computeFileState(extract);
      const state2 = computeFileState(extract);

      expect(state1.hash).toBe(state2.hash);
      expect(state1.fingerprint).toBe(state2.fingerprint);
    });

    it("should produce different hash for different exports", () => {
      const extract1: AstExtract = {
        file: "src/utils/helper.ts",
        exports: [{ kind: "function", name: "formatDate", line: 1, column: 0 }],
        imports: [],
        signatures: [],
      };

      const extract2: AstExtract = {
        file: "src/utils/helper.ts",
        exports: [{ kind: "function", name: "formatCurrency", line: 1, column: 0 }],
        imports: [],
        signatures: [],
      };

      const state1 = computeFileState(extract1);
      const state2 = computeFileState(extract2);

      expect(state1.hash).not.toBe(state2.hash);
    });
  });

  describe("buildCurrentState", () => {
    it("should build state with correct structure", () => {
      const extracts: AstExtract[] = [
        {
          file: "src/auth/login.ts",
          exports: [{ kind: "function", name: "login", line: 1 }],
          imports: [],
          signatures: [],
        },
      ];

      const state = buildCurrentState(extracts);

      expect(state.version).toBe(2);
      expect(state.lastRun).toBeTruthy();
      expect(state.files).toBeTruthy();
      expect(Object.keys(state.files).length).toBe(1);
    });

    it("should normalize paths to POSIX separators preserving case", () => {
      const extracts: AstExtract[] = [
        {
          file: "SRC/Auth/Login.ts",
          exports: [{ kind: "function", name: "login", line: 1 }],
          imports: [],
          signatures: [],
        },
      ];

      const state = buildCurrentState(extracts);
      const keys = Object.keys(state.files);

      // Case is preserved to avoid collisions on case-sensitive filesystems
      expect(keys[0]).toBe("SRC/Auth/Login.ts");
    });

    it("should keep distinct entries for files differing only in case", () => {
      const extracts: AstExtract[] = [
        {
          file: "src/utils/Helper.ts",
          exports: [{ kind: "function", name: "Helper", line: 1 }],
          imports: [],
          signatures: [],
        },
        {
          file: "src/utils/helper.ts",
          exports: [{ kind: "function", name: "helper", line: 1 }],
          imports: [],
          signatures: [],
        },
      ];

      const state = buildCurrentState(extracts);
      const keys = Object.keys(state.files);

      // On case-sensitive FS, these are different files — must not collide
      expect(keys.length).toBe(2);
      expect(keys).toContain("src/utils/Helper.ts");
      expect(keys).toContain("src/utils/helper.ts");
    });
  });

  describe("diffStates", () => {
    it("should detect added files", () => {
      const extracts: AstExtract[] = [
        {
          file: "src/new-file.ts",
          exports: [{ kind: "function", name: "newExport", line: 1 }],
          imports: [],
          signatures: [],
        },
      ];

      const result = diffStates(extracts, null);

      expect(result.added.length).toBe(1);
      expect(result.added[0]!.path).toBe("src/new-file.ts");
      expect(result.added[0]!.changeType).toBe("ADDED");
    });

    it("should detect modified files", () => {
      const previousState = {
        version: 2 as const,
        lastRun: new Date().toISOString(),
        files: {
          "src/utils/helper.ts": {
            hash: "oldhash123",
            fingerprint: "oldfingerprint",
            changedAt: 0,
          },
        },
      };

      const currentExtracts: AstExtract[] = [
        {
          file: "src/utils/helper.ts",
          exports: [{ kind: "function", name: "helper", line: 1 }],
          imports: [],
          signatures: [],
        },
      ];

      const result = diffStates(currentExtracts, previousState);

      expect(result.modified.length).toBe(1);
      expect(result.modified[0]!.path).toBe("src/utils/helper.ts");
      expect(result.modified[0]!.changeType).toBe("MODIFIED");
    });

    it("should detect removed files", () => {
      const previousState = {
        version: 2 as const,
        lastRun: new Date().toISOString(),
        files: {
          "src/old-file.ts": {
            hash: "somehash",
            fingerprint: "somefingerprint",
            changedAt: 0,
          },
        },
      };

      const result = diffStates([], previousState);

      expect(result.removed.length).toBe(1);
      expect(result.removed[0]!.path).toBe("src/old-file.ts");
      expect(result.removed[0]!.changeType).toBe("REMOVED");
    });

    it("should detect untouched files", () => {
      const currentExtracts: AstExtract[] = [
        {
          file: "src/utils/helper.ts",
          exports: [{ kind: "function", name: "helper", line: 1 }],
          imports: [],
          signatures: [],
        },
      ];

      const state = buildCurrentState(currentExtracts);

      const previousState: StateV2 = {
        version: 2 as const,
        lastRun: new Date().toISOString(),
        files: {
          "src/utils/helper.ts": state.files["src/utils/helper.ts"]!,
        },
      };

      const result = diffStates(currentExtracts, previousState);

      expect(result.untouched.length).toBe(1);
      expect(result.untouched[0]!.changeType).toBe("UNTOUCHED");
    });

    it("should group by category", () => {
      const extracts: AstExtract[] = [
        {
          file: "src/auth/login.ts",
          exports: [{ kind: "function", name: "login", line: 1 }],
          imports: [],
          signatures: [],
        },
        {
          file: "src/components/Button.tsx",
          exports: [{ kind: "function", name: "Button", line: 1 }],
          imports: [],
          signatures: [],
        },
      ];

      const result = diffStates(extracts, null);

      expect(result.byCategory.size).toBeGreaterThanOrEqual(2);
    });
  });

  describe("getDiffSummary", () => {
    it("should format added changes", () => {
      const extracts: AstExtract[] = [
        {
          file: "src/new.ts",
          exports: [{ kind: "function", name: "newExport", line: 1 }],
          imports: [],
          signatures: [],
        },
      ];

      const result = diffStates(extracts, null);
      const summary = getDiffSummary(result);

      expect(summary).toBe("+1");
    });

    it("should format mixed changes", () => {
      const previousState = {
        version: 2 as const,
        lastRun: new Date().toISOString(),
        files: {
          "src/modified.ts": { hash: "old", fingerprint: "old", changedAt: 0 },
          "src/removed.ts": { hash: "old", fingerprint: "old", changedAt: 0 },
        },
      };

      const currentExtracts: AstExtract[] = [
        {
          file: "src/modified.ts",
          exports: [{ kind: "function", name: "modified", line: 1 }],
          imports: [],
          signatures: [],
        },
        {
          file: "src/added.ts",
          exports: [{ kind: "function", name: "added", line: 1 }],
          imports: [],
          signatures: [],
        },
      ];

      const result = diffStates(currentExtracts, previousState);
      const summary = getDiffSummary(result);

      expect(summary).toContain("+1");
      expect(summary).toContain("~1");
      expect(summary).toContain("-1");
    });

    it("should return 'no changes' when unchanged", () => {
      const currentExtracts: AstExtract[] = [
        {
          file: "src/unchanged.ts",
          exports: [{ kind: "function", name: "unchanged", line: 1 }],
          imports: [],
          signatures: [],
        },
      ];

      const state = buildCurrentState(currentExtracts);
      const previousState: StateV2 = {
        version: 2 as const,
        lastRun: new Date().toISOString(),
        files: {
          "src/unchanged.ts": state.files["src/unchanged.ts"]!,
        },
      };

      const result = diffStates(currentExtracts, previousState);
      const summary = getDiffSummary(result);

      expect(summary).toBe("no changes");
    });
  });

  describe("loadState/saveState", () => {
    const testRoot = process.cwd();

    it("should save and load state correctly", async () => {
      const state = buildCurrentState([
        {
          file: "src/test.ts",
          exports: [{ kind: "function", name: "test", line: 1 }],
          imports: [],
          signatures: [],
        },
      ]);

      saveState(state, testRoot);
      const loaded = loadState(testRoot);

      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(2);
      expect(loaded!.files["src/test.ts"]).toBeTruthy();

      clearState(testRoot);
    });

    it("should return null for non-existent state", () => {
      clearState(testRoot);
      const loaded = loadState(testRoot);
      expect(loaded).toBeNull();
    });
  });

  describe("validateNoStaleReferences", () => {
    it("should detect stale references to removed files", () => {
      const previousState = {
        version: 2 as const,
        lastRun: new Date().toISOString(),
        files: {
          "src/deleted.ts": { hash: "hash", fingerprint: "fp", changedAt: 0 },
        },
      };

      const currentExtracts: AstExtract[] = [];
      const diffResult = diffStates(currentExtracts, previousState);

      const snapshot = {
        version: 2 as const,
        generatedAt: new Date().toISOString(),
        targetDir: process.cwd(),
        entries: [
          {
            id: "123",
            tech: "Test",
            simple: "Test",
            ref: "[src/deleted.ts:1]",
            category: "utils" as const,
          },
        ],
        warnings: [],
      };

      const violations = validateNoStaleReferences(snapshot, diffResult);

      expect(violations.length).toBe(1);
      expect(violations[0]).toContain("STALE_REF");
    });

    it("should pass for valid references", () => {
      const currentExtracts: AstExtract[] = [
        {
          file: "src/valid.ts",
          exports: [{ kind: "function", name: "valid", line: 1 }],
          imports: [],
          signatures: [],
        },
      ];

      const diffResult = diffStates(currentExtracts, null);

      const snapshot = {
        version: 2 as const,
        generatedAt: new Date().toISOString(),
        targetDir: process.cwd(),
        entries: [
          {
            id: "123",
            tech: "Test",
            simple: "Test",
            ref: "[src/valid.ts:1]",
            category: "utils" as const,
          },
        ],
        warnings: [],
      };

      const violations = validateNoStaleReferences(snapshot, diffResult);

      expect(violations.length).toBe(0);
    });

    it("should be case-sensitive when matching stale references", () => {
      const previousState = {
        version: 2 as const,
        lastRun: new Date().toISOString(),
        files: {
          "src/Deleted.ts": { hash: "hash", fingerprint: "fp", changedAt: 0 },
        },
      };

      const currentExtracts: AstExtract[] = [];
      const diffResult = diffStates(currentExtracts, previousState);

      // Reference with different case should NOT match the removed file
      const snapshot = {
        version: 2 as const,
        generatedAt: new Date().toISOString(),
        targetDir: process.cwd(),
        entries: [
          {
            id: "123",
            tech: "Test",
            simple: "Test",
            ref: "[src/deleted.ts:1]",
            category: "utils" as const,
          },
        ],
        warnings: [],
      };

      const violations = validateNoStaleReferences(snapshot, diffResult);
      // Case-sensitive: src/deleted.ts != src/Deleted.ts, so no stale ref
      expect(violations.length).toBe(0);
    });
  });
});
