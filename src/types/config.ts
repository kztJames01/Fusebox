import * as path from "node:path";
import { z } from "zod";
import {
  DEFAULT_RANKING_CONFIG,
  RankingConfigSchema,
} from "./ranking.js";

export const AIMEMORY_CONFIG_FILE = ".memolog.json";

export const AiMemoryModeSchema = z.enum(["tech", "simple", "dual", "brief"]);

export const FilterLevelSchema = z.enum(["trivial", "logic", "all"]);

const StringListSchema = z.array(z.string().trim().min(1));

export const DEFAULT_CORE_PATHS = [
  "src/engine/",
  "src/cli/",
  "src/parsers/",
  "src/security/",
  "src/output/",
] as const;

export const DEFAULT_CRITICAL_PATHS = [
  "src/auth/**",
  "src/api/**",
  "src/security/**",
] as const;

export const DocsConfigSchema = z
  .object({
    criticalPaths: StringListSchema.default([...DEFAULT_CRITICAL_PATHS]),
    requireDocComments: z.boolean().default(true),
  })
  .strict();

export type DocsConfig = z.infer<typeof DocsConfigSchema>;

export const DEFAULT_DOCS_CONFIG: DocsConfig = {
  criticalPaths: [...DEFAULT_CRITICAL_PATHS],
  requireDocComments: true,
};

export const RustCoreModeSchema = z.enum(["off", "auto", "required"]);
export type RustCoreMode = z.infer<typeof RustCoreModeSchema>;

// Context-pack defaults. 1M is a ceiling, not a target: the pack still ranks,
// deduplicates, and truncates, so small projects stay small.
export const DEFAULT_EXPORT_CONTEXT_MAX_TOKENS = 1_000_000;

export const ExportContextConfigSchema = z
  .object({
    defaultMaxTokens: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_EXPORT_CONTEXT_MAX_TOKENS),
    // LongContextReorder places the highest-impact facts at the start and end
    // of the pack so the middle of a long context is never the most important.
    reorder: z.boolean().default(true),
  })
  .strict();

export type ExportContextConfig = z.infer<typeof ExportContextConfigSchema>;

export const DEFAULT_EXPORT_CONTEXT_CONFIG: ExportContextConfig = {
  defaultMaxTokens: DEFAULT_EXPORT_CONTEXT_MAX_TOKENS,
  reorder: true,
};

const OutputPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !isMalformedOutputPath(value), {
    message: "Malformed output path",
  });

export const AiMemoryOutputSchema = z
  .object({
    markdown: OutputPathSchema,
    json: OutputPathSchema,
  })
  .strict();

export const AiMemoryConfigSchema = z
  .object({
    languages: StringListSchema,
    exclude: StringListSchema,
    output: AiMemoryOutputSchema,
    maxDepth: z.number().int().nonnegative(),
    timeoutMs: z.number().int().positive().optional().default(30000),
    maxFileSizeBytes: z.number().int().positive().optional().default(2097152),
    mode: AiMemoryModeSchema,
    filter: FilterLevelSchema.optional().default("logic"),
    trackTypes: z.boolean().optional().default(false),
    corePaths: StringListSchema.optional().default([...DEFAULT_CORE_PATHS]),
    ranking: RankingConfigSchema.optional().default(DEFAULT_RANKING_CONFIG),
    docs: DocsConfigSchema.optional().default(DEFAULT_DOCS_CONFIG),
    rustCore: RustCoreModeSchema.optional().default("auto"),
    exportContext: ExportContextConfigSchema.optional().default(
      DEFAULT_EXPORT_CONTEXT_CONFIG,
    ),
  })
  .strict();

export const AiMemoryConfigOverridesSchema = z
  .object({
    languages: StringListSchema.optional(),
    exclude: StringListSchema.optional(),
    output: AiMemoryOutputSchema.partial().optional(),
    maxDepth: z.number().int().nonnegative().optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxFileSizeBytes: z.number().int().positive().optional(),
    mode: AiMemoryModeSchema.optional(),
    filter: FilterLevelSchema.optional(),
    trackTypes: z.boolean().optional(),
    corePaths: StringListSchema.optional(),
    ranking: RankingConfigSchema.optional(),
    docs: DocsConfigSchema.partial().optional(),
    rustCore: RustCoreModeSchema.optional(),
    exportContext: ExportContextConfigSchema.partial().optional(),
  })
  .strict();

export type AiMemoryMode = z.infer<typeof AiMemoryModeSchema>;
export type FilterLevel = z.infer<typeof FilterLevelSchema>;
export type AiMemoryOutput = z.infer<typeof AiMemoryOutputSchema>;
export type AiMemoryConfig = z.infer<typeof AiMemoryConfigSchema>;
export type AiMemoryConfigOverrides = z.infer<
  typeof AiMemoryConfigOverridesSchema
>;

// V2 FROZEN: extension depends on these default output names (MEMO_LOG.md, MEMO_LOG.json).
// Do not rename them without a new extension major version or a settings migration.
export const DEFAULT_AI_MEMORY_CONFIG: AiMemoryConfig = {
  languages: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "pyi", "rs", "go"],
  exclude: [".git", "node_modules", "dist", "build", ".memo-log", ".env*", "*.key", "*.pem", "credentials.*", "secrets.*"],
  output: {
    markdown: "MEMO_LOG.md",
    json: "MEMO_LOG.json",
  },
  maxDepth: 20,
  timeoutMs: 30000,
  maxFileSizeBytes: 2097152,
  mode: "dual",
  filter: "logic",
  trackTypes: false,
  corePaths: [...DEFAULT_CORE_PATHS],
  ranking: DEFAULT_RANKING_CONFIG,
  docs: DEFAULT_DOCS_CONFIG,
  rustCore: "auto",
  exportContext: DEFAULT_EXPORT_CONTEXT_CONFIG,
};

export function normalizeStringList(
  values: readonly string[],
  options: { lowercase?: boolean } = {},
): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    let normalized = value.trim();
    if (options.lowercase) {
      normalized = normalized.toLowerCase();
    }
    if (normalized.length > 0) {
      seen.add(normalized);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function normalizeExcludeList(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const cleaned = trimTrailingSeparators(value.trim());
    if (cleaned.length > 0) {
      seen.add(cleaned);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function normalizeOutputPath(rawPath: string, rootDir: string): string {
  const trimmed = rawPath.trim();
  if (isMalformedOutputPath(trimmed)) {
    throw new Error(`Malformed output path: ${rawPath}`);
  }

  const resolvedRoot = path.resolve(rootDir);
  const resolvedPath = path.resolve(resolvedRoot, trimmed);
  if (!isPathInsideRoot(resolvedRoot, resolvedPath)) {
    throw new Error(
      `Output path "${rawPath}" resolves outside scan root "${resolvedRoot}"`,
    );
  }

  const relative = path.relative(resolvedRoot, resolvedPath);
  if (!relative || relative === ".") {
    throw new Error(`Output path "${rawPath}" must point to a file`);
  }

  return toPosixPath(relative);
}

export function normalizeAiMemoryConfig(
  config: AiMemoryConfig,
  rootDir: string,
): AiMemoryConfig {
  return {
    languages: normalizeStringList(config.languages, { lowercase: true }),
    exclude: normalizeExcludeList(config.exclude),
    output: {
      markdown: normalizeOutputPath(config.output.markdown, rootDir),
      json: normalizeOutputPath(config.output.json, rootDir),
    },
    maxDepth: config.maxDepth,
    timeoutMs: config.timeoutMs ?? 30000,
    maxFileSizeBytes: config.maxFileSizeBytes ?? 2097152,
    mode: config.mode,
    filter: config.filter ?? "logic",
    trackTypes: config.trackTypes ?? false,
    corePaths: normalizeStringList(config.corePaths ?? DEFAULT_CORE_PATHS),
    ranking: config.ranking ?? DEFAULT_RANKING_CONFIG,
    docs: {
      criticalPaths: normalizeStringList(
        config.docs?.criticalPaths ?? DEFAULT_DOCS_CONFIG.criticalPaths,
      ),
      requireDocComments:
        config.docs?.requireDocComments ?? DEFAULT_DOCS_CONFIG.requireDocComments,
    },
    rustCore: config.rustCore ?? "auto",
    exportContext: {
      defaultMaxTokens:
        config.exportContext?.defaultMaxTokens ??
        DEFAULT_EXPORT_CONTEXT_CONFIG.defaultMaxTokens,
      reorder: config.exportContext?.reorder ?? DEFAULT_EXPORT_CONTEXT_CONFIG.reorder,
    },
  };
}

export function isMalformedOutputPath(input: string): boolean {
  if (input.length === 0) {
    return true;
  }

  if (/[\u0000-\u001F]/.test(input)) {
    return true;
  }

  if (/[\\/]\s*$/.test(input)) {
    return true;
  }

  const normalizedSeparators = input.replace(/\\/g, "/");
  const segments = normalizedSeparators.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return true;
  }

  return false;
}

function trimTrailingSeparators(value: string): string {
  if (value.length === 0) {
    return value;
  }
  return value.replace(/[\\/]+$/g, "");
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}
