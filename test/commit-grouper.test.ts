import { describe, expect, it } from "vitest";
import { CommitGrouper, type CommitGroup } from "../src/engine/commit-grouper.js";
import { parseGitNameStatusOutput, type GitChange, GitService } from "../src/engine/git.js";
import type { AstExtract } from "../src/types/scan.js";

describe("parseGitNameStatusOutput", () => {
  it("parses A/M/D tab-delimited lines", () => {
    const raw = ["A\tsrc/new.ts", "M\tsrc/changed.ts", "D\tsrc/old.ts"].join("\n");
    const parsed = parseGitNameStatusOutput(raw);
    expect(parsed).toEqual([
      { status: "M", filePath: "src/changed.ts" },
      { status: "A", filePath: "src/new.ts" },
      { status: "D", filePath: "src/old.ts" },
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(parseGitNameStatusOutput("")).toEqual([]);
  });

  it("returns empty array for whitespace-only lines", () => {
    expect(parseGitNameStatusOutput("   \n  \n")).toEqual([]);
  });

  it("skips stat summary lines", () => {
    const raw = [
      "M\tsrc/auth/login.ts",
      " src/auth/login.ts | 2 +-",
      " 3 files changed, 2 insertions(+), 1 deletion(-)",
    ].join("\n");
    const parsed = parseGitNameStatusOutput(raw);
    expect(parsed).toEqual([{ status: "M", filePath: "src/auth/login.ts" }]);
  });

  it("skips malformed lines without status code", () => {
    const raw = ["garbage line", "M\tsrc/ok.ts", "no-status-here"].join("\n");
    const parsed = parseGitNameStatusOutput(raw);
    expect(parsed).toEqual([{ status: "M", filePath: "src/ok.ts" }]);
  });

  it("skips lines with status but no file path", () => {
    const raw = "M\t\nA\t  \nD\tsrc/valid.ts";
    const parsed = parseGitNameStatusOutput(raw);
    expect(parsed).toEqual([{ status: "D", filePath: "src/valid.ts" }]);
  });

  it("deduplicates identical status+path entries", () => {
    const raw = ["A\tsrc/dup.ts", "A\tsrc/dup.ts"].join("\n");
    const parsed = parseGitNameStatusOutput(raw);
    expect(parsed).toEqual([{ status: "A", filePath: "src/dup.ts" }]);
  });

  it("allows same path with different statuses", () => {
    const raw = ["A\tsrc/file.ts", "M\tsrc/file.ts"].join("\n");
    const parsed = parseGitNameStatusOutput(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.status).toBe("A");
    expect(parsed[1]!.status).toBe("M");
  });

  it("normalizes R (rename) to M", () => {
    const raw = "R100\tsrc/old.ts\tsrc/new.ts";
    const parsed = parseGitNameStatusOutput(raw);
    expect(parsed).toEqual([{ status: "M", filePath: "src/new.ts" }]);
  });

  it("normalizes C (copy) to M", () => {
    const raw = "C80\tsrc/orig.ts\tsrc/copy.ts";
    const parsed = parseGitNameStatusOutput(raw);
    expect(parsed).toEqual([{ status: "M", filePath: "src/copy.ts" }]);
  });

  it("normalizes T (typechange) to M", () => {
    const raw = "T\tsrc/file.ts";
    const parsed = parseGitNameStatusOutput(raw);
    expect(parsed).toEqual([{ status: "M", filePath: "src/file.ts" }]);
  });

  it("normalizes U (unmerged) to M", () => {
    const raw = "U\tsrc/conflict.ts";
    const parsed = parseGitNameStatusOutput(raw);
    expect(parsed).toEqual([{ status: "M", filePath: "src/conflict.ts" }]);
  });

  it("normalizes X (unknown) to M", () => {
    const raw = "X\tsrc/unknown.ts";
    const parsed = parseGitNameStatusOutput(raw);
    expect(parsed).toEqual([{ status: "M", filePath: "src/unknown.ts" }]);
  });

  it("normalizes B (broken pair) to M", () => {
    const raw = "B\tsrc/broken.ts";
    const parsed = parseGitNameStatusOutput(raw);
    expect(parsed).toEqual([{ status: "M", filePath: "src/broken.ts" }]);
  });

  it("normalizes backslashes to forward slashes", () => {
    const raw = "M\\src\\\\auth\\\\login.ts";
    const parsed = parseGitNameStatusOutput(raw);
    if (parsed.length > 0) {
      expect(parsed[0]!.filePath).not.toContain("\\");
    }
  });

  it("sorts output by filePath then status", () => {
    const raw = ["D\tsrc/b.ts", "A\tsrc/a.ts", "M\tsrc/a.ts"].join("\n");
    const parsed = parseGitNameStatusOutput(raw);
    expect(parsed.map((c) => `${c.status}:${c.filePath}`)).toEqual([
      "A:src/a.ts",
      "M:src/a.ts",
      "D:src/b.ts",
    ]);
  });

  it("handles mixed status codes with score digits", () => {
    const raw = ["R099\tsrc/old.ts\tsrc/renamed.ts", "C050\tsrc/base.ts\tsrc/copied.ts"].join("\n");
    const parsed = parseGitNameStatusOutput(raw);
    expect(parsed).toEqual([
      { status: "M", filePath: "src/copied.ts" },
      { status: "M", filePath: "src/renamed.ts" },
    ]);
  });
});

describe("CommitGrouper.groupChanges", () => {
  it("groups auth files into auth scope", () => {
    const changes: GitChange[] = [{ status: "M", filePath: "src/auth/session.ts" }];
    const groups = CommitGrouper.groupChanges(changes);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.scope).toBe("auth");
  });

  it("groups api files into api scope", () => {
    const changes: GitChange[] = [{ status: "A", filePath: "src/api/client.ts" }];
    const groups = CommitGrouper.groupChanges(changes);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.scope).toBe("api");
  });

  it("groups component files into components scope", () => {
    const changes: GitChange[] = [{ status: "M", filePath: "src/components/Button.tsx" }];
    const groups = CommitGrouper.groupChanges(changes);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.scope).toBe("components");
  });

  it("groups utils files into utils scope", () => {
    const changes: GitChange[] = [{ status: "M", filePath: "src/utils/format.ts" }];
    const groups = CommitGrouper.groupChanges(changes);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.scope).toBe("utils");
  });

  it("groups styles files into styles scope", () => {
    const changes: GitChange[] = [{ status: "M", filePath: "src/styles/theme.css" }];
    const groups = CommitGrouper.groupChanges(changes);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.scope).toBe("styles");
  });

  it("groups test files into test scope", () => {
    const changes: GitChange[] = [{ status: "M", filePath: "test/auth.test.ts" }];
    const groups = CommitGrouper.groupChanges(changes);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.scope).toBe("test");
  });

  it("groups config files into config scope", () => {
    const changes: GitChange[] = [{ status: "M", filePath: "src/config/settings.ts" }];
    const groups = CommitGrouper.groupChanges(changes);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.scope).toBe("config");
  });

  it("groups chore files (package.json, tsconfig, workflows) into chore scope", () => {
    const changes: GitChange[] = [
      { status: "M", filePath: "package.json" },
      { status: "M", filePath: "tsconfig.json" },
      { status: "M", filePath: ".github/workflows/ci.yml" },
    ];
    const groups = CommitGrouper.groupChanges(changes);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.scope).toBe("chore");
    expect(groups[0]!.files).toHaveLength(3);
  });

  it("groups multiple changes into separate scopes", () => {
    const changes: GitChange[] = [
      { status: "A", filePath: "src/auth/session.ts" },
      { status: "M", filePath: "src/api/client.ts" },
      { status: "M", filePath: "src/components/Card.tsx" },
      { status: "M", filePath: "src/utils/format.ts" },
      { status: "M", filePath: "src/styles/theme.css" },
      { status: "M", filePath: "test/auth.test.ts" },
      { status: "M", filePath: "package.json" },
    ];
    const groups = CommitGrouper.groupChanges(changes);
    const scopes = groups.map((g) => g.scope);
    expect(scopes).toEqual(["auth", "api", "components", "utils", "styles", "test", "chore"]);
  });

  it("returns groups sorted by scope priority", () => {
    const changes: GitChange[] = [
      { status: "M", filePath: "package.json" },
      { status: "A", filePath: "src/auth/login.ts" },
      { status: "M", filePath: "src/components/Button.tsx" },
    ];
    const groups = CommitGrouper.groupChanges(changes);
    const scopes = groups.map((g) => g.scope);
    expect(scopes).toEqual(["auth", "components", "chore"]);
  });

  it("deduplicates file paths within a scope", () => {
    const changes: GitChange[] = [
      { status: "A", filePath: "src/auth/login.ts" },
      { status: "M", filePath: "src/auth/login.ts" },
    ];
    const groups = CommitGrouper.groupChanges(changes);
    expect(groups[0]!.files).toEqual(["src/auth/login.ts"]);
    expect(groups[0]!.changes).toHaveLength(2);
  });

  it("sorts files within a group alphabetically", () => {
    const changes: GitChange[] = [
      { status: "M", filePath: "src/utils/zebra.ts" },
      { status: "M", filePath: "src/utils/alpha.ts" },
    ];
    const groups = CommitGrouper.groupChanges(changes);
    expect(groups[0]!.files).toEqual(["src/utils/alpha.ts", "src/utils/zebra.ts"]);
  });

  it("returns empty array for empty input", () => {
    expect(CommitGrouper.groupChanges([])).toEqual([]);
  });
});

describe("CommitGrouper.generateMessage", () => {
  it("produces conventional commit format: type(scope): summary", () => {
    const group: CommitGroup = {
      scope: "auth",
      files: ["src/auth/login.ts"],
      changes: [{ status: "A", filePath: "src/auth/login.ts" }],
      type: "feat",
    };
    const msg = CommitGrouper.generateMessage(group);
    expect(msg).toBe("feat(auth): update auth module");
  });

  it("uses fix for modified-only group", () => {
    const group: CommitGroup = {
      scope: "api",
      files: ["src/api/client.ts"],
      changes: [{ status: "M", filePath: "src/api/client.ts" }],
      type: "fix",
    };
    const msg = CommitGrouper.generateMessage(group);
    expect(msg).toBe("fix(api): update api module");
  });

  it("uses refactor for deleted-only group", () => {
    const group: CommitGroup = {
      scope: "utils",
      files: ["src/utils/old.ts"],
      changes: [{ status: "D", filePath: "src/utils/old.ts" }],
      type: "refactor",
    };
    const msg = CommitGrouper.generateMessage(group);
    expect(msg).toBe("refactor(utils): update utils module");
  });

  it("uses style for styles scope", () => {
    const group: CommitGroup = {
      scope: "styles",
      files: ["src/styles/theme.css"],
      changes: [{ status: "M", filePath: "src/styles/theme.css" }],
      type: "style",
    };
    const msg = CommitGrouper.generateMessage(group);
    expect(msg).toBe("style(styles): update styles module");
  });

  it("uses test for test scope", () => {
    const group: CommitGroup = {
      scope: "test",
      files: ["test/auth.test.ts"],
      changes: [{ status: "M", filePath: "test/auth.test.ts" }],
      type: "test",
    };
    const msg = CommitGrouper.generateMessage(group);
    expect(msg).toBe("test(test): update test module");
  });

  it("uses chore for chore scope", () => {
    const group: CommitGroup = {
      scope: "chore",
      files: ["package.json"],
      changes: [{ status: "M", filePath: "package.json" }],
      type: "chore",
    };
    const msg = CommitGrouper.generateMessage(group);
    expect(msg).toBe("chore(chore): update chore module");
  });

  it("includes file count for multi-file groups", () => {
    const group: CommitGroup = {
      scope: "components",
      files: ["src/components/Button.tsx", "src/components/Card.tsx", "src/components/Modal.tsx"],
      changes: [
        { status: "M", filePath: "src/components/Button.tsx" },
        { status: "M", filePath: "src/components/Card.tsx" },
        { status: "M", filePath: "src/components/Modal.tsx" },
      ],
      type: "fix",
    };
    const msg = CommitGrouper.generateMessage(group);
    expect(msg).toBe("fix(components): update component modules (3 files)");
  });

  it("uses singular 'module' for single file", () => {
    const group: CommitGroup = {
      scope: "config",
      files: ["src/config/settings.ts"],
      changes: [{ status: "M", filePath: "src/config/settings.ts" }],
      type: "fix",
    };
    const msg = CommitGrouper.generateMessage(group);
    expect(msg).toBe("fix(config): update config module");
  });
});

describe("scope resolution — isChoreFile patterns", () => {
  const chorePaths = [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "pnpm-lock.yml",
    "yarn.lock",
    "bun.lockb",
    "tsconfig.json",
    "tsconfig.node.json",
    "tsconfig.base.json",
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    "vitest.config.ts",
    "vitest.config.mts",
    "vitest.config.cts",
    "tsup.config.ts",
    "tsup.config.mts",
    "tsup.config.cts",
    ".npmrc",
    ".nvmrc",
    ".github/workflows/ci.yml",
    ".github/workflows/deploy.yml",
    ".vscode/settings.json",
  ];

  it.each(chorePaths)("maps %s to chore scope", (filePath) => {
    const groups = CommitGrouper.groupChanges([{ status: "M", filePath }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.scope).toBe("chore");
  });

  it("does not map a regular source file to chore", () => {
    const groups = CommitGrouper.groupChanges([{ status: "M", filePath: "src/auth/login.ts" }]);
    expect(groups[0]!.scope).not.toBe("chore");
  });

  it("is case-insensitive for package.json", () => {
    const groups = CommitGrouper.groupChanges([{ status: "M", filePath: "Package.JSON" }]);
    expect(groups[0]!.scope).toBe("chore");
  });

  it("is case-insensitive for tsconfig variants", () => {
    const groups = CommitGrouper.groupChanges([{ status: "M", filePath: "TSConfig.json" }]);
    expect(groups[0]!.scope).toBe("chore");
  });

  it("matches chore files in subdirectories by basename", () => {
    const groups = CommitGrouper.groupChanges([{ status: "M", filePath: "subdir/package.json" }]);
    expect(groups[0]!.scope).toBe("chore");
  });
});

describe("conventional type inference", () => {
  it("returns feat for added-only changes", () => {
    const groups = CommitGrouper.groupChanges([{ status: "A", filePath: "src/auth/new.ts" }]);
    expect(groups[0]!.type).toBe("feat");
  });

  it("returns fix for modified-only changes", () => {
    const groups = CommitGrouper.groupChanges([{ status: "M", filePath: "src/auth/existing.ts" }]);
    expect(groups[0]!.type).toBe("fix");
  });

  it("returns refactor for deleted-only changes", () => {
    const groups = CommitGrouper.groupChanges([{ status: "D", filePath: "src/auth/old.ts" }]);
    expect(groups[0]!.type).toBe("refactor");
  });

  it("returns refactor for mixed deleted + modified (no added)", () => {
    const groups = CommitGrouper.groupChanges([
      { status: "M", filePath: "src/auth/existing.ts" },
      { status: "D", filePath: "src/auth/old.ts" },
    ]);
    expect(groups[0]!.type).toBe("refactor");
  });

  it("returns feat for added + modified (no deleted)", () => {
    const groups = CommitGrouper.groupChanges([
      { status: "A", filePath: "src/auth/new.ts" },
      { status: "M", filePath: "src/auth/existing.ts" },
    ]);
    expect(groups[0]!.type).toBe("feat");
  });

  it("returns refactor for added + deleted", () => {
    const groups = CommitGrouper.groupChanges([
      { status: "A", filePath: "src/auth/new.ts" },
      { status: "D", filePath: "src/auth/old.ts" },
    ]);
    expect(groups[0]!.type).toBe("refactor");
  });

  it("returns refactor for added + modified + deleted", () => {
    const groups = CommitGrouper.groupChanges([
      { status: "A", filePath: "src/auth/new.ts" },
      { status: "M", filePath: "src/auth/existing.ts" },
      { status: "D", filePath: "src/auth/old.ts" },
    ]);
    expect(groups[0]!.type).toBe("refactor");
  });

  it("returns style for styles scope regardless of status", () => {
    const groups = CommitGrouper.groupChanges([{ status: "A", filePath: "src/styles/new.css" }]);
    expect(groups[0]!.type).toBe("style");
  });

  it("returns test for test scope regardless of status", () => {
    const groups = CommitGrouper.groupChanges([{ status: "A", filePath: "__tests__/unit.test.ts" }]);
    expect(groups[0]!.type).toBe("test");
  });

  it("returns chore for chore scope regardless of status", () => {
    const groups = CommitGrouper.groupChanges([{ status: "A", filePath: "package.json" }]);
    expect(groups[0]!.type).toBe("chore");
  });
});

describe("git command rendering", () => {
  it("renders a ready-to-paste add+commit command", () => {
    const service = new GitService(process.cwd());
    const command = service.renderCommitCommand(
      ["src/auth/login.ts", "src/api/client.ts"],
      "feat(auth): update auth module",
    );
    expect(command).toContain("git add -A --");
    expect(command).toContain("git commit -m");
  });
});

describe("CommitGrouper.groupChangesByDependency", () => {
  it("groups directly dependent changed files together", () => {
    const changes: GitChange[] = [
      { status: "M", filePath: "src/api/client.ts" },
      { status: "M", filePath: "src/auth/login.ts" },
      { status: "M", filePath: "src/utils/format.ts" },
    ];

    const extracts: AstExtract[] = [
      {
        file: "src/api/client.ts",
        exports: [{ name: "fetchUser", line: 1, kind: "function" }],
        imports: ["../auth/login", "../utils/format"],
        signatures: ["fetchUser()"],
      },
      {
        file: "src/auth/login.ts",
        exports: [{ name: "loginUser", line: 1, kind: "function" }],
        imports: [],
        signatures: ["loginUser()"],
      },
      {
        file: "src/utils/format.ts",
        exports: [{ name: "formatDate", line: 1, kind: "function" }],
        imports: [],
        signatures: ["formatDate()"],
      },
    ];

    const groups = CommitGrouper.groupChangesByDependency(changes, extracts);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.files).toEqual([
      "src/api/client.ts",
      "src/auth/login.ts",
      "src/utils/format.ts",
    ]);
  });

  it("keeps independent changed files in separate groups", () => {
    const changes: GitChange[] = [
      { status: "M", filePath: "src/auth/login.ts" },
      { status: "M", filePath: "src/components/Button.tsx" },
    ];

    const extracts: AstExtract[] = [
      {
        file: "src/auth/login.ts",
        exports: [{ name: "loginUser", line: 1, kind: "function" }],
        imports: [],
        signatures: ["loginUser()"],
      },
      {
        file: "src/components/Button.tsx",
        exports: [{ name: "Button", line: 1, kind: "function" }],
        imports: [],
        signatures: ["Button()"],
      },
    ];

    const groups = CommitGrouper.groupChangesByDependency(changes, extracts);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.files.length).toBe(1);
    expect(groups[1]!.files.length).toBe(1);
  });

  it("includes removed files as standalone groups when no extract exists", () => {
    const changes: GitChange[] = [
      { status: "D", filePath: "src/old/deleted.ts" },
      { status: "M", filePath: "src/auth/login.ts" },
    ];

    const extracts: AstExtract[] = [
      {
        file: "src/auth/login.ts",
        exports: [{ name: "loginUser", line: 1, kind: "function" }],
        imports: [],
        signatures: ["loginUser()"],
      },
    ];

    const groups = CommitGrouper.groupChangesByDependency(changes, extracts);
    const flattened = groups.flatMap((g) => g.files);
    expect(flattened).toContain("src/old/deleted.ts");
    expect(flattened).toContain("src/auth/login.ts");
  });
});
