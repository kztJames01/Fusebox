// UI-only preferences for the interactive menu.
//
// This file is never read by scan, ticket materialization, or MCP. Ranking
// weights and MEMO_LOG bytes stay in `.memolog.json` and the scan pipeline.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomicSync } from "../engine/atomicWrite.js";

export const SESSION_PREFS_RELATIVE = ".memo-log/session-prefs.json";

export const SessionPrefsSchema = z
  .object({
    schema: z.literal(1),
    lastMenu: z.string().min(1).max(40).optional(),
    filter: z.string().max(200).optional(),
  })
  .strict();

export type SessionPrefs = z.infer<typeof SessionPrefsSchema>;

export const DEFAULT_SESSION_PREFS: SessionPrefs = { schema: 1 };

export function sessionPrefsPath(rootDir: string): string {
  return join(rootDir, SESSION_PREFS_RELATIVE);
}

export function loadSessionPrefs(rootDir: string): SessionPrefs {
  try {
    const parsed = SessionPrefsSchema.safeParse(
      JSON.parse(readFileSync(sessionPrefsPath(rootDir), "utf8")),
    );
    return parsed.success ? parsed.data : { ...DEFAULT_SESSION_PREFS };
  } catch {
    return { ...DEFAULT_SESSION_PREFS };
  }
}

export function saveSessionPrefs(rootDir: string, prefs: SessionPrefs): void {
  const parsed = SessionPrefsSchema.parse(prefs);
  writeFileAtomicSync(
    sessionPrefsPath(rootDir),
    `${JSON.stringify(parsed, null, 2)}\n`,
  );
}
