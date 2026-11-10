import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildCacheEntry,
  createEmptyCache,
  extractFromCacheEntry,
  hasFileChanged,
  hashContent,
  loadCache,
  saveCache,
} from "../src/engine/cache.js";
import { resolveExtractForFile } from "../src/engine/cachedParse.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("cache", () => {
  it("second resolve hits cache when content unchanged", async () => {
    const code = "export function foo() { return 1; }\n";
    const filePath = "/tmp/sample.ts";
    const cache = createEmptyCache();

    const first = await resolveExtractForFile(
      filePath,
      "src/x.ts",
      code,
      code.length,
      cache,
      { filter: "logic", trackTypes: false },
    );
    expect(first.fromCache).toBe(false);

    const second = await resolveExtractForFile(
      filePath,
      "src/x.ts",
      code,
      code.length,
      cache,
      { filter: "logic", trackTypes: false },
    );
    expect(second.fromCache).toBe(true);
    expect(second.extract?.exports.some((e) => e.name === "foo")).toBe(true);
  });

  it("persists cache atomically under project root", async () => {
    const root = await tempDir("memolog-cache-");
    const cache = createEmptyCache();
    cache.files["a.ts"] = buildCacheEntry(
      [{ name: "a", line: 1, kind: "const" }],
      [],
      [],
      "ts",
      hashContent("export const a = 1;"),
      "utils",
      20,
    );
    saveCache(cache, root);

    const loaded = loadCache(root);
    expect(loaded?.files["a.ts"]?.hash).toBe(cache.files["a.ts"]?.hash);
    expect(extractFromCacheEntry("a.ts", loaded!.files["a.ts"]!)?.exports[0]?.name).toBe("a");
  });

  it("detects content changes via hash", () => {
    const entry = buildCacheEntry(
      [{ name: "a", line: 1, kind: "const" }],
      [],
      [],
      "ts",
      hashContent("v1"),
      "utils",
      2,
    );
    expect(hasFileChanged("f.ts", "v1", entry)).toBe(false);
    expect(hasFileChanged("f.ts", "v2", entry)).toBe(true);
  });
});
