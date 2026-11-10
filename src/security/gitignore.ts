import { readFile } from "node:fs/promises";
import path from "node:path";

import { normalizeRelativePath } from "./pathGuards.js";
import type { TraversalWarning } from "./types.js";

interface CompiledPattern {
  negated: boolean;
  directoryOnly: boolean;
  regex: RegExp;
}

export interface IgnoreMatcher {
  isIgnored: (relativePath: string, isDirectory: boolean) => boolean;
  warnings: TraversalWarning[];
}

interface CompilePatternInput {
  rawPattern: string;
  sourceLabel: string;
  lineNumber?: number;
}

function escapeRegExp(input: string): string {
  return input.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegexSegment(pattern: string): string {
  let expression = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    const nextCharacter = pattern[index + 1] ?? "";

    if (character === "*" && nextCharacter === "*") {
      expression += ".*";
      index += 1;
      continue;
    }

    if (character === "*") {
      expression += "[^/]*";
      continue;
    }

    if (character === "?") {
      expression += "[^/]";
      continue;
    }

    expression += escapeRegExp(character);
  }

  return expression;
}

function compilePattern({
  rawPattern,
  sourceLabel,
  lineNumber
}: CompilePatternInput): { pattern?: CompiledPattern; warning?: TraversalWarning } {
  let pattern = rawPattern.trim();
  const locationSuffix = lineNumber ? ` at line ${lineNumber}` : "";

  if (!pattern) {
    return {};
  }

  if (pattern.startsWith("#") && !pattern.startsWith("\\#")) {
    return {};
  }

  if (pattern.endsWith("\\")) {
    return {
      warning: {
        code: "PARSE_ISSUE",
        message: `Could not parse pattern "${rawPattern}" from ${sourceLabel}${locationSuffix}`
      }
    };
  }

  let negated = false;
  if (pattern.startsWith("!") && !pattern.startsWith("\\!")) {
    negated = true;
    pattern = pattern.slice(1);
  }

  pattern = pattern.replace(/^\\([#!])/, "$1");

  if (!pattern) {
    return {
      warning: {
        code: "PARSE_ISSUE",
        message: `Could not parse empty pattern from ${sourceLabel}${locationSuffix}`
      }
    };
  }

  const anchored = pattern.startsWith("/");
  const directoryOnly = pattern.endsWith("/");

  if (anchored) {
    pattern = pattern.slice(1);
  }

  if (directoryOnly) {
    pattern = pattern.slice(0, -1);
  }

  pattern = normalizeRelativePath(pattern);

  if (!pattern) {
    return {
      warning: {
        code: "PARSE_ISSUE",
        message: `Could not parse root-only pattern from ${sourceLabel}${locationSuffix}`
      }
    };
  }

  const hasSlash = pattern.includes("/");
  const body = globToRegexSegment(pattern);

  const prefix = anchored ? "^" : "(^|.*/)";
  const suffix = directoryOnly ? "(?:/.*)$" : "(?:$|/.*$)";

  // Bare names in .gitignore and custom excludes match any segment unless rooted with "/".
  const regex = hasSlash
    ? new RegExp(`${prefix}${body}${suffix}`)
    : anchored
      ? new RegExp(`^${body}${suffix}`)
      : new RegExp(`(^|.*/)${body}${suffix}`);

  return {
    pattern: {
      negated,
      directoryOnly,
      regex
    }
  };
}

async function loadRootGitIgnore(rootPath: string): Promise<string> {
  const gitIgnorePath = path.join(rootPath, ".gitignore");

  try {
    return await readFile(gitIgnorePath, "utf8");
  } catch {
    return "";
  }
}

export async function createIgnoreMatcher(
  rootPath: string,
  customExcludes: string[]
): Promise<IgnoreMatcher> {
  const warnings: TraversalWarning[] = [];
  const compiled: CompiledPattern[] = [];

  const gitIgnoreText = await loadRootGitIgnore(rootPath);
  const gitIgnoreLines = gitIgnoreText.split(/\r?\n/);

  for (let index = 0; index < gitIgnoreLines.length; index += 1) {
    const result = compilePattern({
      rawPattern: gitIgnoreLines[index] ?? "",
      sourceLabel: ".gitignore",
      lineNumber: index + 1
    });

    if (result.warning) {
      warnings.push(result.warning);
      continue;
    }

    if (result.pattern) {
      compiled.push(result.pattern);
    }
  }

  for (const customPattern of customExcludes) {
    const result = compilePattern({
      rawPattern: customPattern,
      sourceLabel: "custom excludes"
    });

    if (result.warning) {
      warnings.push(result.warning);
      continue;
    }

    if (result.pattern) {
      compiled.push(result.pattern);
    }
  }

  return {
    warnings,
    isIgnored: (relativePath: string, isDirectory: boolean): boolean => {
      const normalizedPath = normalizeRelativePath(relativePath);
      const candidate = isDirectory ? `${normalizedPath}/` : normalizedPath;

      if (!candidate) {
        return false;
      }

      let ignored = false;
      for (const pattern of compiled) {
        if (!pattern.regex.test(candidate)) {
          continue;
        }

        ignored = !pattern.negated;
      }

      return ignored;
    }
  };
}
