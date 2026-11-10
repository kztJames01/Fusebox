import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadEffectiveConfig, runScanCommand } from "../src/engine/index.js";
import { categorizeFile } from "../src/types/categories.js";

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures/multi-lang");

function normalizeVolatile(content: string): string {
  return content
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<ts>")
    .replace(/"generatedAt":\s*"[^"]+"/g, '"generatedAt": "<ts>"')
    .replace(/"lastScan":\s*"[^"]+"/g, '"lastScan": "<ts>"')
    .replace(/"lastCalibrated":\s*"[^"]+"/g, '"lastCalibrated": "<ts>"')
    .replace(/"mtime":\s*\d+/g, '"mtime": 0')
    .replace(/"changedAt":\s*\d+/g, '"changedAt": 0');
}

describe("multi-lang fixtures", () => {
  it("categorizes auth.* the same across languages", () => {
    expect(categorizeFile("auth/login.py")).toBe("auth");
    expect(categorizeFile("auth/login.rs")).toBe("auth");
    expect(categorizeFile("auth/login.go")).toBe("auth");
  });

  it("produces identical brief markdown on repeated scans", async () => {
    const config = await loadEffectiveConfig({ targetDir: fixtureRoot, mode: "brief" });

    const first = await runScanCommand({
      targetDir: fixtureRoot,
      mode: "brief",
      format: "md",
      effectiveConfig: config,
      quiet: true,
    });

    const second = await runScanCommand({
      targetDir: fixtureRoot,
      mode: "brief",
      format: "md",
      effectiveConfig: config,
      quiet: true,
    });

    expect(first.markdownPath).toBeDefined();
    const a = normalizeVolatile(await fs.readFile(first.markdownPath!, "utf8"));
    const b = normalizeVolatile(await fs.readFile(second.markdownPath!, "utf8"));
    expect(a).toBe(b);
  });
});
