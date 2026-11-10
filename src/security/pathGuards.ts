import { access, constants, lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";

export class SecurityPathError extends Error {
  public readonly candidatePath: string;

  public constructor(message: string, candidatePath: string) {
    super(message);
    this.name = "SecurityPathError";
    this.candidatePath = candidatePath;
  }
}

export async function resolveSecureRoot(rootPath: string): Promise<string> {
  if (rootPath.includes("\u0000")) {
    throw new SecurityPathError("Root path contains invalid null byte", rootPath);
  }
  const absoluteRoot = path.resolve(rootPath);
  try {
    await access(absoluteRoot, constants.R_OK);
  } catch (error) {
    throw new SecurityPathError(
      `Root path is not readable: ${error instanceof Error ? error.message : "unknown error"}`,
      rootPath,
    );
  }

  const rootLStat = await lstat(absoluteRoot);
  if (rootLStat.isSymbolicLink()) {
    throw new SecurityPathError("Root path must not be a symbolic link", rootPath);
  }

  const realRoot = await realpath(absoluteRoot);
  const rootStats = await stat(realRoot);

  if (!rootStats.isDirectory()) {
    throw new SecurityPathError("Root path must be a directory", rootPath);
  }

  return realRoot;
}

export function normalizeRelativePath(inputPath: string): string {
  if (inputPath.includes("\u0000")) {
    throw new SecurityPathError("Path contains invalid null byte", inputPath);
  }
  const normalized = path.posix
    .normalize(inputPath.replace(/\\/g, "/"))
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");

  return normalized === "." ? "" : normalized;
}

export function isPathWithinRoot(rootRealPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootRealPath, candidatePath);

  if (relative === "") {
    return true;
  }

  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function assertPathWithinRoot(rootRealPath: string, candidatePath: string): void {
  if (containsParentTraversal(candidatePath)) {
    throw new SecurityPathError("Path contains parent traversal segment", candidatePath);
  }
  if (!isPathWithinRoot(rootRealPath, candidatePath)) {
    throw new SecurityPathError("Path escapes secure root", candidatePath);
  }
}

export async function resolveAndAssertPath(rootRealPath: string, candidatePath: string): Promise<string> {
  let resolvedPath = candidatePath;
  try {
    const statResult = await lstat(candidatePath);
    if (statResult.isSymbolicLink()) {
      resolvedPath = await realpath(candidatePath);
    }
  } catch (error) {
    throw new SecurityPathError(
      `PATH_RESOLVE_ERROR: ${error instanceof Error ? error.message : "unknown error"}`,
      candidatePath,
    );
  }
  if (containsParentTraversal(resolvedPath)) {
    throw new SecurityPathError("Path contains parent traversal segment", resolvedPath);
  }
  if (!isPathWithinRoot(rootRealPath, resolvedPath)) {
    throw new SecurityPathError("SYMLINK_ESCAPE", resolvedPath);
  }
  return resolvedPath;
}

export function toContainedRelativePath(
  rootRealPath: string,
  candidatePath: string
): string {
  assertPathWithinRoot(rootRealPath, candidatePath);
  return normalizeRelativePath(path.relative(rootRealPath, candidatePath));
}

function containsParentTraversal(rawPath: string): boolean {
  const normalized = rawPath.replace(/\\/g, "/");
  return normalized.split("/").some((segment) => segment === "..");
}
