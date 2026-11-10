import type { SupportedLang, ExportKind } from "../parsers/types.js";

export interface StructuralScanOptions {
  quiet?: boolean | undefined;
  includeAgentNotes?: boolean | undefined;
  timeoutMs?: number | undefined;
  excludes?: string[] | undefined;
  maxDepth?: number | undefined;
  maxFileSizeBytes?: number | undefined;
}

export interface ExportInfo {
  name: string;
  line: number;
  column?: number;
  kind: ExportKind;
  /** Documentation comment text that already exists in the source file. */
  doc?: string | undefined;
  /** Deterministic structural signature, used for breaking-change detection. */
  signature?: string | undefined;
}

export interface AstExtract {
  file: string;
  lang?: SupportedLang | undefined;
  contentHash?: string | undefined;
  /** Hash after removing comments and whitespace; used for formatting-only diffs. */
  normalizedContentHash?: string | undefined;
  exports: ExportInfo[];
  imports: string[];
  signatures: string[];
}
