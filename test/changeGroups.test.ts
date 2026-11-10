import { describe, expect, it } from "vitest";

import { buildChangeFacts, buildChangeGroups, buildGroupChecklist } from "../src/engine/changeGroups.js";
import type { FileDiff } from "../src/engine/diff.js";
import type { AstExtract } from "../src/types/scan.js";
import type { ChangeSet } from "../src/types/ticket.js";

function change(path: string, exportsAdded: string[] = []): ChangeSet {
  return { path, changeType: "ADDED", category: "utils", exportsAdded, exportsRemoved: [], signaturesChanged: [], impactScore: 0.2 };
}

function diff(path: string): FileDiff {
  return {
    path,
    changeType: "ADDED",
    category: "utils",
    previousState: undefined,
    currentState: { hash: "a".repeat(64), fingerprint: "b".repeat(16), changedAt: 0 },
  };
}

function extract(path: string, names: readonly string[], kind: "const" | "function" = "const"): AstExtract {
  return {
    file: path,
    exports: names.map((name, index) => ({ name, kind, line: index + 1 })),
    imports: [],
    signatures: [],
  };
}

describe("change groups", () => {
  it("collapses a 200-export barrel into one reexport group and one checklist row", () => {
    const names = Array.from({ length: 200 }, (_, index) => `export${index}`);
    const groups = buildChangeGroups({
      changes: [change("src/index.ts", names)],
      fileDiffs: [diff("src/index.ts")],
      extracts: [extract("src/index.ts", names)],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: "reexport_churn", scopeKey: "src", fileCount: 1, risk: "P3", summaryStats: { reexports: 200 },
    });
    expect(buildGroupChecklist("T-0123456789ab", groups)).toHaveLength(1);
  });

  it("groups lockfiles as one dependency review unit", () => {
    const changes = [change("package-lock.json"), change("pnpm-lock.yaml")];
    const groups = buildChangeGroups({ changes, fileDiffs: changes.map((entry) => diff(entry.path)), extracts: [] });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "deps", scopeKey: "manifests", fileCount: 2, risk: "P1" });
  });

  it("turns a missing baseline into one deterministic snapshot group", () => {
    const changes = [change("src/a.ts", ["a"]), change("src/b.ts", ["b"])];
    const first = buildChangeGroups({
      changes,
      fileDiffs: changes.map((entry) => diff(entry.path)),
      extracts: [extract("src/a.ts", ["a"]), extract("src/b.ts", ["b"])],
      baselineMissing: true,
    });
    const second = buildChangeGroups({
      changes: [...changes].reverse(),
      fileDiffs: [...changes].reverse().map((entry) => diff(entry.path)),
      extracts: [extract("src/b.ts", ["b"]), extract("src/a.ts", ["a"])],
      baselineMissing: true,
    });

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: "baseline", fileCount: 2, risk: "P3" });
    expect(second).toEqual(first);
  });

  it("classifies API additions, behavior, renames, formatting, and security sinks", () => {
    const additions = [
      change("src/api/new.ts", ["createThing"]),
      { ...change("src/api/old.ts"), changeType: "MODIFIED" as const },
      { ...change("src/auth/crypto.ts"), changeType: "MODIFIED" as const, category: "auth" as const },
    ];
    const fileDiffs: FileDiff[] = [
      { ...diff("src/api/new.ts"), currentState: { ...diff("src/api/new.ts").currentState!, hash: "c".repeat(64) } },
      { path: "src/api/old.ts", changeType: "MODIFIED", category: "api", previousState: { hash: "d".repeat(64), fingerprint: "e".repeat(16), changedAt: 0 }, currentState: { hash: "f".repeat(64), fingerprint: "e".repeat(16), changedAt: 0 } },
      { path: "src/auth/crypto.ts", changeType: "MODIFIED", category: "auth", previousState: { hash: "1".repeat(64), fingerprint: "2".repeat(16), changedAt: 0 }, currentState: { hash: "3".repeat(64), fingerprint: "4".repeat(16), changedAt: 0 } },
    ];
    const groups = buildChangeGroups({
      changes: additions,
      fileDiffs,
      extracts: [extract("src/api/new.ts", ["createThing"], "function"), extract("src/api/old.ts", [])],
      contents: new Map([["src/api/old.ts", "export function old() { return 1; }\n"]]),
      previousContents: new Map([["src/api/old.ts", "export function old() { return 1; }\n"]]),
    });

    expect(groups.map((group) => group.kind)).toEqual(["behavior", "api_add", "formatting"]);
    expect(groups.find((group) => group.kind === "behavior")?.risk).toBe("P0");
  });

  it("emits stable symbol facts and hunk references", () => {
    const changes = [{ ...change("src/api/new.ts", ["createThing", "Thing"]), changeType: "MODIFIED" as const }];
    const fileDiffs: FileDiff[] = [{
      path: "src/api/new.ts",
      changeType: "MODIFIED",
      category: "api",
      previousState: { hash: "a".repeat(64), fingerprint: "b".repeat(16), changedAt: 0 },
      currentState: { hash: "c".repeat(64), fingerprint: "d".repeat(16), changedAt: 0 },
    }];
    const facts = buildChangeFacts({ changes, fileDiffs, extracts: [extract("src/api/new.ts", ["createThing", "Thing"], "function")] });
    expect(facts).toHaveLength(2);
    expect(facts.every((fact) => /^F:[0-9a-f]{16}$/.test(fact.id))).toBe(true);
    expect(new Set(facts.map((fact) => fact.hunkId)).size).toBe(1);
    expect(buildChangeFacts({ changes, fileDiffs, extracts: [extract("src/api/new.ts", ["createThing", "Thing"], "function")] })).toEqual(facts);
  });
});
