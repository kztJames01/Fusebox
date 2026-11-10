import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildCurrentState,
  detectBreakingChanges,
} from "../src/engine/diff.js";
import {
  breakingChangesFingerprint,
  CHANGELOG_SCAFFOLD_FILE,
  MIGRATION_SCAFFOLD_FILE,
  writeBreakingChangeScaffolds,
} from "../src/engine/scaffolds.js";
import type { AstExtract } from "../src/types/scan.js";

function extract(
  file: string,
  exports: AstExtract["exports"],
): AstExtract {
  return {
    file,
    exports,
    imports: [],
    signatures: exports
      .filter((item) => item.signature !== undefined)
      .map((item) => item.signature as string),
  };
}

const before: AstExtract[] = [
  extract("src/auth.ts", [
    { name: "login", kind: "function", line: 3, signature: "function login(email)" },
    { name: "logout", kind: "function", line: 7, signature: "function logout()" },
    { name: "Session", kind: "class", line: 11, signature: "class Session" },
  ]),
];

const after: AstExtract[] = [
  extract("src/auth.ts", [
    {
      name: "login",
      kind: "function",
      line: 3,
      signature: "function login(email, password)",
    },
    { name: "Session", kind: "const", line: 11 },
  ]),
];

describe("breaking-change detection", () => {
  it("persists structural export data in state", () => {
    const state = buildCurrentState(before);
    const stored = state.files["src/auth.ts"];
    expect(stored?.exports?.login).toEqual({
      kind: "function",
      line: 3,
      signature: "function login(email)",
    });
    expect(stored?.exports?.logout?.kind).toBe("function");
  });

  it("detects removed exports, signature changes, and kind changes", () => {
    const state = buildCurrentState(before);
    const changes = detectBreakingChanges(state, after);

    expect(changes).toHaveLength(3);
    expect(changes.map((change) => change.kind).sort()).toEqual([
      "EXPORT_KIND_CHANGED",
      "EXPORT_REMOVED",
      "SIGNATURE_CHANGED",
    ]);

    const removed = changes.find((change) => change.kind === "EXPORT_REMOVED");
    expect(removed?.exportName).toBe("logout");
    expect(removed?.path).toBe("src/auth.ts");

    const signature = changes.find((change) => change.kind === "SIGNATURE_CHANGED");
    expect(signature?.exportName).toBe("login");
    expect(signature?.previous).toContain("email");
    expect(signature?.current).toContain("password");

    const kind = changes.find((change) => change.kind === "EXPORT_KIND_CHANGED");
    expect(kind?.exportName).toBe("Session");
    expect(kind?.previous).toBe("class");
    expect(kind?.current).toBe("const");
  });

  it("does not guess for legacy state without export data", () => {
    const legacy = {
      version: 2 as const,
      lastRun: "2026-01-01T00:00:00.000Z",
      files: {
        "src/auth.ts": {
          hash: "abc",
          fingerprint: "def",
          changedAt: 1,
        },
      },
    };
    expect(detectBreakingChanges(legacy, after)).toEqual([]);
  });
});

describe("diff-aware scaffolds", () => {
  it("writes verifiable, marker-delimited scaffolds and is idempotent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memolog-scaffold-"));
    const changes = detectBreakingChanges(buildCurrentState(before), after);
    const fingerprint = breakingChangesFingerprint(changes);

    const first = writeBreakingChangeScaffolds(root, changes);
    expect(first.written).toBe(true);
    expect(first.fingerprint).toBe(fingerprint);

    const changelogPath = path.join(root, CHANGELOG_SCAFFOLD_FILE);
    const migrationPath = path.join(root, MIGRATION_SCAFFOLD_FILE);
    const firstChangelog = await fs.readFile(changelogPath, "utf8");
    const firstMigration = await fs.readFile(migrationPath, "utf8");

    expect(firstChangelog).toContain(`<!-- memo-log:breaking:${fingerprint} -->`);
    expect(firstChangelog).toContain("TODO(human)");
    expect(firstChangelog).toContain("export `logout` was removed");
    expect(firstChangelog).toContain("signature of `login` changed");
    expect(firstMigration).toContain(`## Pending migration (${fingerprint})`);

    const second = writeBreakingChangeScaffolds(root, changes);
    expect(second.written).toBe(false);
    expect(await fs.readFile(changelogPath, "utf8")).toBe(firstChangelog);
    expect(await fs.readFile(migrationPath, "utf8")).toBe(firstMigration);
  });

  it("appends a new block for a different diff without overwriting human edits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memolog-scaffold-append-"));
    const firstChanges = detectBreakingChanges(buildCurrentState(before), after);
    writeBreakingChangeScaffolds(root, firstChanges);

    const changelogPath = path.join(root, CHANGELOG_SCAFFOLD_FILE);
    const withHumanEdit = `${await fs.readFile(changelogPath, "utf8")}\n## Human notes\n\nKeep this line.\n`;
    await fs.writeFile(changelogPath, withHumanEdit, "utf8");

    const secondChanges = detectBreakingChanges(buildCurrentState(before), [
      extract("src/auth.ts", []),
    ]);
    const result = writeBreakingChangeScaffolds(root, secondChanges);
    const content = await fs.readFile(changelogPath, "utf8");

    expect(result.written).toBe(true);
    expect(content).toContain("Keep this line.");
    expect(content).toContain(firstChanges.length > 0 ? "TODO(human)" : "");
    expect(content).toContain(`<!-- memo-log:breaking:${result.fingerprint} -->`);
  });

  it("does not create files when there are no breaking changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memolog-scaffold-empty-"));
    const result = writeBreakingChangeScaffolds(root, []);
    expect(result.written).toBe(false);
    await expect(fs.access(path.join(root, CHANGELOG_SCAFFOLD_FILE))).rejects.toThrow();
    await expect(fs.access(path.join(root, MIGRATION_SCAFFOLD_FILE))).rejects.toThrow();
  });
});
