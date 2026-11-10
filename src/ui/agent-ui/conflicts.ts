export {
  ConflictSeverity,
  ConflictEntrySchema,
  ConflictReportSchema,
  detectConflicts,
  validateConflictReport,
  renderConflictMarkdown,
} from "../../engine/conflicts.js";

export type {
  ConflictEntry,
  ConflictReport,
  ConflictReportInput,
  ConflictDetectionOptions,
} from "../../engine/conflicts.js";
