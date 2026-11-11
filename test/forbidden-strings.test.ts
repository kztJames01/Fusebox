// Guards: ensure no network/LLM/eval strings appear in src/
// Fails loudly if any forbidden pattern is found anywhere in source

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC_ROOT = path.resolve("src");

// Patterns that absolutely must not appear in src/
const FORBIDDEN_PATTERNS = [
  { pattern: /\bfetch\s*\(/, label: "fetch()", mode: "raw" as const },
  { pattern: /\baxios\b/, label: "axios", mode: "raw" as const },
  { pattern: /require\(['"]axios['"]\)/, label: "require('axios')", mode: "raw" as const },
  { pattern: /api\.anthropic/, label: "api.anthropic", mode: "raw" as const },
  { pattern: /api\.openai/, label: "api.openai", mode: "raw" as const },
  { pattern: /openai\.com/, label: "openai.com URL", mode: "raw" as const },
  { pattern: /anthropic\.com/, label: "anthropic.com URL", mode: "raw" as const },
  { pattern: /new XMLHttpRequest\b/, label: "XMLHttpRequest", mode: "raw" as const },
  { pattern: /http\.request\s*\(/, label: "http.request()", mode: "raw" as const },
  { pattern: /https\.request\s*\(/, label: "https.request()", mode: "raw" as const },
  { pattern: /\beval\s*\(/, label: "eval()", mode: "code" as const },
  { pattern: /new\s+Function\s*\(/, label: "new Function()", mode: "code" as const },
];

// Files/dirs to skip (test fixtures, docs — not production code)
const SKIP_PATHS = ["node_modules", "dist", ".memo-log", ".ai-memory", "test"];

function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_PATHS.some(s => entry.name === s)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(fullPath));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      results.push(fullPath);
    }
  }
  return results;
}

function stripTemplateStrings(line: string): string {
  return line.replace(/`(?:\\.|[^`\\])*`/g, " ");
}

function stripRegexLiterals(line: string): string {
  return line.replace(/\/(?:\\.|[^\/\n])+\/[gimsuy]*/g, " ");
}

function scanLineForPattern(line: string, entry: (typeof FORBIDDEN_PATTERNS)[number]): boolean {
  const prepared = entry.mode === "code"
    ? stripRegexLiterals(stripTemplateStrings(line))
    : line;
  const matched = entry.pattern.test(prepared);
  entry.pattern.lastIndex = 0;
  return matched;
}

describe("forbidden-strings security gate", () => {
  const files = collectTsFiles(SRC_ROOT);

  it("should find at least some source files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const entry of FORBIDDEN_PATTERNS) {
    it(`should not contain "${entry.label}" in any src/ file`, () => {
      const violations: string[] = [];
      for (const file of files) {
        const content = fs.readFileSync(file, "utf8");
        const relFile = path.relative(process.cwd(), file);
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const rawLine = lines[i] ?? "";
          if (scanLineForPattern(rawLine, entry)) {
            violations.push(`${relFile}:${i + 1}: ${rawLine.trim()}`);
          }
        }
      }
      if (violations.length > 0) {
        throw new Error(
          `SECURITY VIOLATION — "${entry.label}" found in src/:\n` + violations.join("\n")
        );
      }
    });
  }
});
