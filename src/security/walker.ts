/// Directory walker implementation with security guards against symlink escapes, path traversal, and other filesystem edge cases.
import { access, constants, lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Dirent, Stats } from "node:fs";
import { createIgnoreMatcher } from "./gitignore.js";
import {
  normalizeRelativePath,
  resolveAndAssertPath,
  resolveSecureRoot
} from "./pathGuards.js";
import { AIMEMORY_CONFIG_FILE } from "../types/config.js";
import {
  DEFAULT_EXCLUDES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  DEFAULT_TIMEOUT_MS,
  isSensitiveRelativePath
} from "./types.js";
import type {
  DirectoryWalkerOptions,
  ManifestFileEntry,
  ScanManifest,
  TraversalWarning
} from "./types.js";

interface QueueDirectory {
  absolutePath: string;
  relativePath: string;
  depth: number;
}

interface NormalizedWalkerOptions {
  rootPath: string;
  excludes: string[];
  maxDepth: number;
  timeoutMs: number;
  maxFileSizeBytes: number;
}

function toDeterministicWarningString(warning: TraversalWarning): string {
  if (warning.relativePath) {
    return `${warning.code}: ${warning.message} (${warning.relativePath})`;
  }

  return `${warning.code}: ${warning.message}`;
}

function matchesDefaultExclude(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized === AIMEMORY_CONFIG_FILE || normalized.endsWith(`/${AIMEMORY_CONFIG_FILE}`)) {
    return true;
  }
  if (isSensitiveRelativePath(normalized)) {
    return true;
  }

  const segments = normalized.split("/").filter(Boolean);

  for (const segment of segments) {
    if (segment.startsWith(".") && segment !== "..") {
      return true;
    }
    if (DEFAULT_EXCLUDES.includes(segment)) {
      return true;
    }
  }

  return false;
}

function validateOptions(options: DirectoryWalkerOptions): NormalizedWalkerOptions {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const excludes = options.excludes ?? [];

  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error("maxDepth must be a non-negative integer");
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive integer");
  }

  if (!Number.isInteger(maxFileSizeBytes) || maxFileSizeBytes <= 0) {
    throw new Error("maxFileSizeBytes must be a positive integer");
  }

  if (!Array.isArray(excludes) || excludes.some((exclude) => typeof exclude !== "string")) {
    throw new Error("excludes must be an array of strings");
  }

  return {
    rootPath: options.rootPath,
    excludes,
    maxDepth,
    timeoutMs,
    maxFileSizeBytes
  };
}

export async function walkDirectory(options: DirectoryWalkerOptions): Promise<ScanManifest> {
  const normalizedOptions = validateOptions(options);
  const rootPath = await resolveSecureRoot(normalizedOptions.rootPath);
  const startedAt = Date.now();
  const deadline = Date.now() + normalizedOptions.timeoutMs;

  const warnings: TraversalWarning[] = [];
  const entries: ManifestFileEntry[] = [];
  let timedOut = false;

  const ignoreMatcher = await createIgnoreMatcher(rootPath, normalizedOptions.excludes);
  warnings.push(...ignoreMatcher.warnings);

  const visitedDirectories = new Set<string>([rootPath]);
  const pendingDirectories: QueueDirectory[] = [
    {
      absolutePath: rootPath,
      relativePath: "",
      depth: 0
    }
  ];

  const markTimedOut = (): void => {
    if (timedOut) {
      return;
    }

    timedOut = true;
    warnings.push({
      code: "TIMEOUT",
      message: "Traversal timed out before completion"
    });
  };

  while (pendingDirectories.length > 0) {
    if (Date.now() > deadline) {
      markTimedOut();
      break;
    }

    const directory = pendingDirectories.pop();
    if (!directory) {
      break;
    }

    let directoryEntries: Dirent[];
    try {
      await access(directory.absolutePath, constants.R_OK);
      directoryEntries = await readdir(directory.absolutePath, { withFileTypes: true });
    } catch (error) {
      const warning: TraversalWarning = {
        code: "PERMISSION_DENIED",
        message: `Failed to read directory: ${error instanceof Error ? error.message : "Unknown error"}`
      };
      if (directory.relativePath) {
        warning.relativePath = directory.relativePath;
      }
      warnings.push(warning);
      continue;
    }

    const sortedDirectoryEntries = directoryEntries.sort((left, right) =>
      left.name.localeCompare(right.name)
    );

    const childDirectories: QueueDirectory[] = [];

    for (const entry of sortedDirectoryEntries) {
      if (Date.now() > deadline) {
        markTimedOut();
        break;
      }

      const relativePath = normalizeRelativePath(
        directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name
      );
      const absolutePath = path.join(directory.absolutePath, entry.name);
      let resolvedAbsolutePath: string;
      try {
        resolvedAbsolutePath = await resolveAndAssertPath(rootPath, absolutePath);
      } catch (error) {
        if (error instanceof Error && error.message === "SYMLINK_ESCAPE") {
          warnings.push({
            code: "SYMLINK_ESCAPE",
            message: "Symlink escapes secure root and was skipped",
            relativePath,
          });
        } else if (error instanceof Error && error.message.startsWith("PATH_RESOLVE_ERROR")) {
          warnings.push({
            code: "FS_ERROR",
            message: `Failed to resolve path: ${error.message}`,
            relativePath,
          });
        } else {
          warnings.push({
            code: "PATH_TRAVERSAL",
            message: "Resolved entry path escapes secure root and was skipped",
            relativePath,
          });
        }
        continue;
      }

      if (relativePath.split("/").some((segment) => segment === "..")) {
        warnings.push({
          code: "PATH_TRAVERSAL",
          message: "Path traversal segment detected and skipped",
          relativePath,
        });
        continue;
      }

      if (matchesDefaultExclude(relativePath)) {
        continue;
      }

      if (entry.isSymbolicLink()) {
        let linkedStats: Stats;
        try {
          await access(resolvedAbsolutePath, constants.R_OK);
          linkedStats = await stat(resolvedAbsolutePath);
        } catch (error) {
          warnings.push({
            code: "PERMISSION_DENIED",
            message: `Failed to stat symlink target: ${error instanceof Error ? error.message : "Unknown error"}`,
            relativePath
          });
          continue;
        }

        if (linkedStats.isDirectory()) {
          if (ignoreMatcher.isIgnored(relativePath, true)) {
            continue;
          }

          if (directory.depth + 1 > normalizedOptions.maxDepth) {
            continue;
          }

          if (visitedDirectories.has(resolvedAbsolutePath)) {
            continue;
          }

          visitedDirectories.add(resolvedAbsolutePath);
          childDirectories.push({
            absolutePath: resolvedAbsolutePath,
            relativePath,
            depth: directory.depth + 1
          });
          continue;
        }

        if (linkedStats.isFile()) {
          if (ignoreMatcher.isIgnored(relativePath, false)) {
            continue;
          }

          if (linkedStats.size > normalizedOptions.maxFileSizeBytes) {
            warnings.push({
              code: "SKIPPED_LARGE_FILE",
              message: `Skipped file larger than ${normalizedOptions.maxFileSizeBytes} bytes`,
              relativePath
            });
            continue;
          }

          entries.push({
            absolutePath: path.join(rootPath, relativePath),
            relativePath,
            sizeBytes: linkedStats.size,
            mtimeMs: linkedStats.mtimeMs
          });
        }

        continue;
      }

      if (entry.isDirectory()) {
        if (ignoreMatcher.isIgnored(relativePath, true)) {
          continue;
        }

        if (directory.depth + 1 > normalizedOptions.maxDepth) {
          continue;
        }

        childDirectories.push({
          absolutePath: resolvedAbsolutePath,
          relativePath,
          depth: directory.depth + 1
        });
        continue;
      }

      if (entry.isFile()) {
        if (ignoreMatcher.isIgnored(relativePath, false)) {
          continue;
        }

        let fileStats: Stats;
        try {
          await access(resolvedAbsolutePath, constants.R_OK);
          fileStats = await lstat(resolvedAbsolutePath);
        } catch (error) {
          warnings.push({
            code: "PERMISSION_DENIED",
            message: `Failed to stat file: ${error instanceof Error ? error.message : "Unknown error"}`,
            relativePath
          });
          continue;
        }

        if (fileStats.size > normalizedOptions.maxFileSizeBytes) {
          warnings.push({
            code: "SKIPPED_LARGE_FILE",
            message: `Skipped file larger than ${normalizedOptions.maxFileSizeBytes} bytes`,
            relativePath
          });
          continue;
        }

        entries.push({
          absolutePath: path.join(rootPath, relativePath),
          relativePath,
          sizeBytes: fileStats.size,
          mtimeMs: fileStats.mtimeMs
        });
      }
    }

    childDirectories.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      const candidate = childDirectories[index];
      if (candidate) {
        pendingDirectories.push(candidate);
      }
    }

    if (timedOut) {
      break;
    }
  }

  const elapsedMs = Math.max(0, Date.now() - startedAt);

  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  warnings.sort((left, right) => {
    const leftKey = `${left.code}:${left.relativePath ?? ""}:${left.message}`;
    const rightKey = `${right.code}:${right.relativePath ?? ""}:${right.message}`;
    return leftKey.localeCompare(rightKey);
  });

  return {
    rootPath,
    files: entries.map((entry) => entry.absolutePath),
    entries,
    warnings: warnings.map((warning) => toDeterministicWarningString(warning)),
    structuredWarnings: warnings,
    timedOut,
    elapsedMs
  };
}

export type { DirectoryWalkerOptions, ScanManifest, TraversalWarning } from "./types.js";
