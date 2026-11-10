import { open, lstat, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import { PARSER_LIMITS } from "../parsers/types.js";
import { CliError, ExitCode } from "../engine/errors.js";

export interface SafeReadResult {
  content: string;
  size: number;
}

export interface SafeReadOptions {
  expectedSize?: number | undefined;
  rootPath?: string | undefined;
}

const MAX_WARN_LIMIT = 100;

export class WarningLimiter {
  private count = 0;
  private readonly limit: number;
  private suppressed = 0;

  constructor(limit = MAX_WARN_LIMIT) {
    this.limit = limit;
  }

  emit(warnings: string[], message: string): void {
    this.count += 1;
    if (this.count <= this.limit) {
      warnings.push(message);
    } else {
      this.suppressed += 1;
    }
  }

  flush(warnings: string[]): void {
    if (this.suppressed > 0) {
      warnings.push(`... ${this.suppressed} additional warning(s) suppressed`);
    }
  }
}

export async function safeReadFile(
  filePath: string,
  options: SafeReadOptions = {},
): Promise<SafeReadResult> {
  // Resolve symlinks using async APIs before opening the file descriptor.
  // This eliminates the TOCTOU race from sync+async interleaving.
  let resolvedPath = filePath;
  try {
    const linkStat = await lstat(filePath);
    if (linkStat.isSymbolicLink()) {
      resolvedPath = await realpath(filePath);
    }
  } catch {
    throw new CliError(
      `PATH_RESOLVE_ERROR: Failed to resolve path ${filePath}`,
      ExitCode.SecurityError
    );
  }

  if (options.rootPath !== undefined) {
    const relative = path.relative(options.rootPath, resolvedPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new CliError(
        `SYMLINK_ESCAPE: ${filePath} -> ${resolvedPath} escapes root ${options.rootPath}`,
        ExitCode.SecurityError
      );
    }
  }

  // Open the file descriptor directly — all subsequent operations use the fd,
  // which eliminates the TOCTOU window between path resolution and file open.
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(resolvedPath, "r");

    const expectedSize = options.expectedSize;
    const beforeStats: Stats = await fh.stat();
    if (!beforeStats.isFile()) {
      throw new CliError(
        `NOT_A_FILE: ${resolvedPath} is not a regular file`,
        ExitCode.SecurityError
      );
    }
    const effectiveSize = beforeStats.size;

    if (
      expectedSize !== undefined &&
      Number.isFinite(expectedSize) &&
      expectedSize >= 0 &&
      expectedSize !== effectiveSize
    ) {
      throw new CliError(
        `FILE_SIZE_MISMATCH: ${resolvedPath} changed between discovery (${expectedSize}) and read (${effectiveSize})`,
        ExitCode.SecurityError
      );
    }

    if (effectiveSize > PARSER_LIMITS.MAX_FILE_SIZE_BYTES) {
      throw new CliError(
        `FILE_TOO_LARGE: ${resolvedPath} is ${effectiveSize} bytes (limit: ${PARSER_LIMITS.MAX_FILE_SIZE_BYTES})`,
        ExitCode.SecurityError
      );
    }

    // Read with explicit byte count verification (TOCTOU hardening)
    const buffer = Buffer.alloc(effectiveSize > 0 ? effectiveSize : 1);
    const { bytesRead } = await fh.read(buffer, 0, buffer.byteLength, 0);

    if (bytesRead !== effectiveSize) {
      throw new CliError(
        `FILE_TRUNCATED_DURING_READ: ${resolvedPath} — expected ${effectiveSize} bytes but read ${bytesRead}`,
        ExitCode.SecurityError
      );
    }

    // Trim buffer to actual bytesRead in case of zero-padding from overallocation
    const content = buffer.subarray(0, bytesRead).toString("utf-8");

    // Detect concurrent modification via mtime/ctime
    const afterStats: Stats = await fh.stat();
    if (
      effectiveSize !== afterStats.size ||
      beforeStats.mtimeMs !== afterStats.mtimeMs ||
      beforeStats.ctimeMs !== afterStats.ctimeMs ||
      afterStats.size > PARSER_LIMITS.MAX_FILE_SIZE_BYTES
    ) {
      throw new CliError(
        `FILE_CHANGED_DURING_READ: ${resolvedPath} (size before=${effectiveSize} after=${afterStats.size})`,
        ExitCode.SecurityError
      );
    }

    return { content, size: bytesRead };
  } finally {
    await fh?.close();
  }
}

export function buildManifestSizeMap(
  entries: Array<{ absolutePath: string; sizeBytes: number }>
): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of entries) {
    map.set(entry.absolutePath, entry.sizeBytes);
  }
  return map;
}
