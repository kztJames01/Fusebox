export const DEFAULT_EXCLUDES = Object.freeze([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".memo-log"
]);

export function isSensitiveRelativePath(relativePath: string): boolean {
  const base = relativePath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (!base) return false;
  if (base.startsWith(".env")) return true;
  if (base.endsWith(".key") || base.endsWith(".pem")) return true;
  if (base === "credentials" || base.startsWith("credentials.")) return true;
  if (base === "secrets" || base.startsWith("secrets.")) return true;
  return false;
}

export const DEFAULT_MAX_DEPTH = 64;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

export interface DirectoryWalkerOptions {
  rootPath: string;
  excludes?: string[] | undefined;
  maxDepth?: number | undefined;
  timeoutMs?: number | undefined;
  maxFileSizeBytes?: number | undefined;
}

export type TraversalWarningCode =
  | "SKIPPED_LARGE_FILE"
  | "TIMEOUT"
  | "PARSE_ISSUE"
  | "SYMLINK_ESCAPE"
  | "FS_ERROR"
  | "PATH_TRAVERSAL"
  | "PERMISSION_DENIED";

export interface TraversalWarning {
  code: TraversalWarningCode;
  message: string;
  relativePath?: string | undefined;
}

export interface ManifestFileEntry {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
  /** Modification time from the walk; used only as an incremental-read hint. */
  mtimeMs: number;
}

export interface ScanManifest {
  rootPath: string;
  files: string[];
  entries: ManifestFileEntry[];
  warnings: string[];
  structuredWarnings: TraversalWarning[];
  timedOut: boolean;
  elapsedMs: number;
}
