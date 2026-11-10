import { describe, expect, it } from "vitest";

import {
  inferKindFromTech,
  rankEntries,
  scoreEntryImpact,
} from "../src/engine/impactRanking.js";

const AUTH_FUNCTION = {
  ref: "[src/auth/login.ts:10:0]",
  category: "auth",
  tech: "Function/Method: `login`",
};

const UTILS_TYPE = {
  ref: "[src/utils/types.ts:4:0]",
  category: "utils",
  tech: "Class/Type: `Options`",
};

describe("impact ranking", () => {
  it("returns a deterministic score in [0, 1]", () => {
    const first = scoreEntryImpact(AUTH_FUNCTION, {
      changeType: "MODIFIED",
      entriesInFile: 2,
      maxEntriesInFile: 4,
      dependentCount: 3,
      maxDependentCount: 3,
    });
    const second = scoreEntryImpact(AUTH_FUNCTION, {
      changeType: "MODIFIED",
      entriesInFile: 2,
      maxEntriesInFile: 4,
      dependentCount: 3,
      maxDependentCount: 3,
    });

    expect(first).toEqual(second);
    expect(first.total).toBeGreaterThanOrEqual(0);
    expect(first.total).toBeLessThanOrEqual(1);
  });

  it("ranks changed exports above untouched exports", () => {
    const ranked = rankEntries([AUTH_FUNCTION, UTILS_TYPE], (entry) => ({
      changeType: entry === AUTH_FUNCTION ? "MODIFIED" : "UNTOUCHED",
      entriesInFile: 1,
      maxEntriesInFile: 1,
    }));

    expect(ranked[0]?.entry.ref).toBe(AUTH_FUNCTION.ref);
  });

  it("uses category priority when other factors are equal", () => {
    const ranked = rankEntries(
      [
        { ref: "[src/other/a.ts:1:0]", category: "other", tech: "Function/Method: `a`" },
        { ref: "[src/auth/b.ts:1:0]", category: "auth", tech: "Function/Method: `b`" },
      ],
      () => ({ changeType: "MODIFIED", entriesInFile: 1, maxEntriesInFile: 1 }),
    );

    expect(ranked.map((item) => item.entry.category)).toEqual(["auth", "other"]);
  });

  it("honors custom weights", () => {
    const entries = [
      { ref: "[src/auth/a.ts:1:0]", category: "auth", tech: "Function/Method: `a`" },
      { ref: "[src/utils/b.ts:1:0]", category: "utils", tech: "Function/Method: `b`" },
    ];
    const contexts = {
      "[src/auth/a.ts:1:0]": {
        changeType: "MODIFIED" as const,
        entriesInFile: 1,
        maxEntriesInFile: 1,
        dependentCount: 0,
        maxDependentCount: 5,
      },
      "[src/utils/b.ts:1:0]": {
        changeType: "MODIFIED" as const,
        entriesInFile: 1,
        maxEntriesInFile: 1,
        dependentCount: 5,
        maxDependentCount: 5,
      },
    };

    const categoryFirst = rankEntries(
      entries,
      (entry) => contexts[entry.ref as keyof typeof contexts],
      { category: 1, dependents: 0, changeSize: 0, exportChange: 0, recency: 0 },
    );
    const dependentsFirst = rankEntries(
      entries,
      (entry) => contexts[entry.ref as keyof typeof contexts],
      { category: 0, dependents: 1, changeSize: 0, exportChange: 0, recency: 0 },
    );

    expect(categoryFirst[0]?.entry.category).toBe("auth");
    expect(dependentsFirst[0]?.entry.category).toBe("utils");
  });

  it("breaks ties by ref for stable ordering", () => {
    const ranked = rankEntries(
      [
        { ref: "[src/b.ts:1:0]", category: "utils", tech: "Function/Method: `b`" },
        { ref: "[src/a.ts:1:0]", category: "utils", tech: "Function/Method: `a`" },
      ],
      () => ({ changeType: "UNTOUCHED", entriesInFile: 1, maxEntriesInFile: 1 }),
    );

    expect(ranked.map((item) => item.entry.ref)).toEqual([
      "[src/a.ts:1:0]",
      "[src/b.ts:1:0]",
    ]);
  });

  it("infers export kind from deterministic labels", () => {
    expect(inferKindFromTech("Function/Method: `run`")).toBe("function");
    expect(inferKindFromTech("Class/Type: `Options`")).toBe("class");
    expect(inferKindFromTech("Constant/Module: `MAX_SIZE`")).toBe("const");
    expect(inferKindFromTech("Default export: `App`")).toBe("default");
    expect(inferKindFromTech("Authentication & session middleware: `login`")).toBe("function");
  });
});
