import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadAiMemoryConfig } from "../src/engine/config.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("config validation", () => {
  it("resolves a relative config path against the scan target, not the shell cwd", async () => {
    const root = await makeTempDir("memolog-config-rel-");
    const other = await makeTempDir("memolog-config-cwd-");
    await fs.writeFile(path.join(root, "custom.json"), JSON.stringify({ mode: "simple" }), "utf8");

    const previous = process.cwd();
    process.chdir(other);
    try {
      const loaded = loadAiMemoryConfig({ targetDir: root, configPath: "custom.json" });
      expect(loaded.config.mode).toBe("simple");
      expect(loaded.configPath.startsWith(loaded.rootDir)).toBe(true);
      expect(path.basename(loaded.configPath)).toBe("custom.json");
    } finally {
      process.chdir(previous);
    }
  });

  it("accepts a valid .memolog.json", async () => {
    const root = await makeTempDir("memolog-config-valid-");
    const configPath = path.join(root, ".memolog.json");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          languages: ["ts", "js"],
          exclude: ["node_modules", ".git"],
          output: { markdown: "docs/MEMO_LOG.md", json: "docs/MEMO_LOG.json" },
          maxDepth: 10,
          mode: "tech"
        },
        null,
        2
      ),
      "utf8"
    );

    const loaded = loadAiMemoryConfig({ targetDir: root });
    expect(loaded.loadedFromFile).toBe(true);
    expect(loaded.config.mode).toBe("tech");
    expect(loaded.config.maxDepth).toBe(10);
  });

  it("rejects invalid mode", async () => {
    const root = await makeTempDir("memolog-config-mode-");
    const configPath = path.join(root, ".memolog.json");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          languages: ["ts"],
          exclude: [".git"],
          output: { markdown: "MEMO_LOG.md", json: "MEMO_LOG.json" },
          maxDepth: 5,
          mode: "invalid"
        },
        null,
        2
      ),
      "utf8"
    );

    expect(() => loadAiMemoryConfig({ targetDir: root })).toThrow();
  });

  it("rejects negative maxDepth", async () => {
    const root = await makeTempDir("memolog-config-depth-");
    const configPath = path.join(root, ".memolog.json");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          languages: ["ts"],
          exclude: [".git"],
          output: { markdown: "MEMO_LOG.md", json: "MEMO_LOG.json" },
          maxDepth: -1,
          mode: "simple"
        },
        null,
        2
      ),
      "utf8"
    );

    expect(() => loadAiMemoryConfig({ targetDir: root })).toThrow();
  });

  it("defaults ranking weights and accepts partial overrides", async () => {
    const root = await makeTempDir("memolog-config-ranking-");
    const defaults = loadAiMemoryConfig({ targetDir: root });
    expect(defaults.config.ranking.weights.category).toBe(0.25);

    await fs.writeFile(
      path.join(root, ".memolog.json"),
      JSON.stringify({ ranking: { weights: { category: 0.5 } } }),
      "utf8",
    );
    const overridden = loadAiMemoryConfig({ targetDir: root });
    expect(overridden.config.ranking.weights.category).toBe(0.5);
    expect(overridden.config.ranking.weights.changeSize).toBe(0.2);
  });

  it("rejects negative ranking weights", async () => {
    const root = await makeTempDir("memolog-config-ranking-bad-");
    await fs.writeFile(
      path.join(root, ".memolog.json"),
      JSON.stringify({ ranking: { weights: { category: -1 } } }),
      "utf8",
    );

    expect(() => loadAiMemoryConfig({ targetDir: root })).toThrow();
  });

  it("defaults export context to a 1M ceiling and accepts overrides", async () => {
    const root = await makeTempDir("memolog-config-export-");
    const defaults = loadAiMemoryConfig({ targetDir: root });
    expect(defaults.config.exportContext.defaultMaxTokens).toBe(1_000_000);
    expect(defaults.config.exportContext.reorder).toBe(true);

    await fs.writeFile(
      path.join(root, ".memolog.json"),
      JSON.stringify({ exportContext: { defaultMaxTokens: 4000, reorder: false } }),
      "utf8",
    );
    const overridden = loadAiMemoryConfig({ targetDir: root });
    expect(overridden.config.exportContext.defaultMaxTokens).toBe(4000);
    expect(overridden.config.exportContext.reorder).toBe(false);
  });

  it("rejects a non-positive export context budget", async () => {
    const root = await makeTempDir("memolog-config-export-bad-");
    await fs.writeFile(
      path.join(root, ".memolog.json"),
      JSON.stringify({ exportContext: { defaultMaxTokens: 0 } }),
      "utf8",
    );

    expect(() => loadAiMemoryConfig({ targetDir: root })).toThrow();
  });

  it("rejects malformed output paths", async () => {
    const root = await makeTempDir("memolog-config-output-");
    const configPath = path.join(root, ".memolog.json");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          languages: ["ts"],
          exclude: [".git"],
          output: { markdown: "../MEMO_LOG.md", json: "MEMO_LOG.json" },
          maxDepth: 5,
          mode: "simple"
        },
        null,
        2
      ),
      "utf8"
    );

    expect(() => loadAiMemoryConfig({ targetDir: root })).toThrow();
  });
});
