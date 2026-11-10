import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { diffStates } from "../src/engine/diff.js";
import {
  evaluateDocsCoverage,
  globToRegExp,
  matchesCriticalPath,
} from "../src/engine/docsCheck.js";
import { runCli } from "../src/cli/runCli.js";
import type { AstExtract } from "../src/types/scan.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

function extract(
  file: string,
  exports: AstExtract["exports"],
): AstExtract {
  return {
    file,
    exports,
    imports: [],
    signatures: [],
  };
}

describe("docs critical-path matching", () => {
  it("supports the documented glob subset", () => {
    expect(matchesCriticalPath("src/auth/login.ts", ["src/auth/**"])).toBe(true);
    expect(matchesCriticalPath("src/api/v1/users.ts", ["src/**/users.ts"])).toBe(true);
    expect(matchesCriticalPath("src/users.ts", ["src/**/users.ts"])).toBe(true);
    expect(matchesCriticalPath("src/auth/deep/login.ts", ["src/*/login.ts"])).toBe(false);
    expect(globToRegExp("src/**/login.ts").test("src/login.ts")).toBe(true);
  });
});

describe("docs coverage evaluation", () => {
  const extracts: AstExtract[] = [
    extract("src/auth/login.ts", [
      { name: "login", kind: "function", line: 2, doc: "Authenticate a user." },
    ]),
    extract("src/auth/logout.ts", [
      { name: "logout", kind: "function", line: 1 },
    ]),
    extract("src/utils/clip.ts", [
      { name: "clip", kind: "function", line: 1 },
    ]),
  ];

  it("reports undocumented exports only in changed critical files", () => {
    const diffResult = diffStates(extracts, null);
    const result = evaluateDocsCoverage(diffResult, extracts, {
      criticalPaths: ["src/auth/**"],
    });

    expect(result.ok).toBe(false);
    expect(result.checkedFiles).toBe(2);
    expect(result.totalExports).toBe(2);
    expect(result.documentedExports).toBe(1);
    expect(result.coverage).toBe(0.5);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.path).toBe("src/auth/logout.ts");
    expect(result.violations[0]?.missingDocs).toEqual(["logout"]);
  });

  it("can be configured to require structure only", () => {
    const diffResult = diffStates(extracts, null);
    const result = evaluateDocsCoverage(diffResult, extracts, {
      criticalPaths: ["src/auth/**"],
      requireDocComments: false,
    });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.coverage).toBe(1);
  });
});

describe("scan --check-docs", () => {
  it("exits 5 with machine-readable JSON in quiet mode", async () => {
    const root = await makeTempDir("memolog-docs-cli-");
    await runCli(["init", root]);
    await writeFile(
      root,
      "src/auth/login.ts",
      "export function login(email: string) { return email; }\n",
    );

    await runCli(["scan", root, "--format", "md", "--quiet"]);
    await writeFile(
      root,
      "src/auth/login.ts",
      [
        "export function login(email: string) { return email; }",
        "export function resetPassword(email: string) { return email; }",
        "",
      ].join("\n"),
    );

    const stdout: string[] = [];
    const stderr: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalError = console.error;
    process.stdout.write = ((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    console.error = (...args: unknown[]) => {
      stderr.push(args.map((entry) => String(entry)).join(" "));
    };

    try {
      const exitCode = await runCli([
        "scan",
        root,
        "--check-docs",
        "--format",
        "md",
        "--quiet",
      ]);

      expect(exitCode).toBe(5);
      const payload = stdout.join("");
      expect(payload).not.toContain("Docs check failed");
      const parsed = JSON.parse(payload.trim()) as {
        kind: string;
        ok: boolean;
        violations: Array<{ path: string; missingDocs: string[] }>;
      };
      expect(parsed.kind).toBe("memo-log-docs-check");
      expect(parsed.ok).toBe(false);
      expect(parsed.violations[0]?.path).toBe("src/auth/login.ts");
      expect(parsed.violations[0]?.missingDocs).toContain("resetPassword");
      expect(stderr).toEqual([]);
    } finally {
      process.stdout.write = originalWrite;
      console.error = originalError;
    }
  });

  it("passes when changed critical exports are documented", async () => {
    const root = await makeTempDir("memolog-docs-cli-ok-");
    await runCli(["init", root]);
    await writeFile(
      root,
      "src/auth/login.ts",
      "export function login(email: string) { return email; }\n",
    );
    await runCli(["scan", root, "--format", "md", "--quiet"]);

    await writeFile(
      root,
      "src/auth/login.ts",
      [
        "/** Authenticate a user. */",
        "export function login(email: string) { return email; }",
        "",
      ].join("\n"),
    );

    const stdout: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const exitCode = await runCli([
        "scan",
        root,
        "--check-docs",
        "--format",
        "md",
        "--quiet",
      ]);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout.join("").trim()) as { ok: boolean };
      expect(parsed.ok).toBe(true);
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
