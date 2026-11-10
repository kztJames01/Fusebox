import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";
import {
  evaluateCompliance,
  renderCompliance,
} from "../src/engine/docsCheck.js";
import type { AstExtract } from "../src/types/scan.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    chunks,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

const extracts: AstExtract[] = [
  {
    file: "src/auth/login.ts",
    exports: [
      { name: "login", kind: "function", line: 2, doc: "Authenticate a user." },
      { name: "logout", kind: "function", line: 6 },
    ],
    imports: [],
    signatures: [],
  },
  {
    file: "src/api/users.ts",
    exports: [{ name: "listUsers", kind: "function", line: 1, doc: "List users." }],
    imports: [],
    signatures: [],
  },
  {
    file: "src/utils/clip.ts",
    exports: [{ name: "clip", kind: "function", line: 1 }],
    imports: [],
    signatures: [],
  },
];

describe("compliance report", () => {
  it("reports whole-tree coverage on critical paths only", () => {
    const result = evaluateCompliance(extracts, {
      criticalPaths: ["src/auth/**", "src/api/**"],
    });

    expect(result.kind).toBe("memo-log-docs-compliance");
    expect(result.criticalFiles).toBe(2);
    expect(result.totalExports).toBe(3);
    expect(result.documentedExports).toBe(2);
    expect(result.coverage).toBeCloseTo(0.666667, 5);
    expect(result.uncoveredFiles).toHaveLength(1);
    expect(result.uncoveredFiles[0]?.path).toBe("src/auth/login.ts");
    expect(result.uncoveredFiles[0]?.missingDocs).toEqual(["logout"]);
    expect(renderCompliance(result)).toContain("66.67%");
  });

  it("is deterministic regardless of input order", () => {
    const first = evaluateCompliance(extracts, { criticalPaths: ["src/**"] });
    const second = evaluateCompliance([...extracts].reverse(), { criticalPaths: ["src/**"] });
    expect(second).toEqual(first);
  });
});

describe("compliance CLI", () => {
  it("prints JSON and fails below --min-coverage", async () => {
    const root = await makeTempDir("memolog-compliance-");
    await runCli(["init", root]);
    await writeFile(
      root,
      "src/auth/login.ts",
      [
        "/** Authenticate a user. */",
        "export function login(email: string) { return email; }",
        "export function logout() {}",
        "",
      ].join("\n"),
    );

    const capture = captureStdout();
    let exit: number;
    try {
      exit = await runCli(["compliance", root, "--json"]);
    } finally {
      capture.restore();
    }
    expect(exit).toBe(0);
    const payload = JSON.parse(capture.chunks.join("").trim()) as {
      kind: string;
      coverage: number;
      uncoveredFiles: Array<{ path: string }>;
    };
    expect(payload.kind).toBe("memo-log-docs-compliance");
    expect(payload.coverage).toBe(0.5);
    expect(payload.uncoveredFiles[0]?.path).toBe("src/auth/login.ts");

    const failCapture = captureStdout();
    let failExit: number;
    try {
      failExit = await runCli(["compliance", root, "--json", "--min-coverage", "0.9"]);
    } finally {
      failCapture.restore();
    }
    expect(failExit).toBe(5);

    expect(await runCli(["compliance", root, "--min-coverage", "0.4"])).toBe(0);
    expect(await runCli(["compliance", root, "--min-coverage", "2"])).toBe(2);
  });
});
