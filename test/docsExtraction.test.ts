import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectStructuralScan,
  loadEffectiveConfig,
} from "../src/engine/index.js";
import { generateDualOutput } from "../src/output/dual-generator.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

describe("documentation extraction", () => {
  it("attaches existing JSDoc and signatures to exports", async () => {
    const root = await makeTempDir("memolog-docs-extract-");
    await writeFile(
      root,
      "src/auth/login.ts",
      [
        "/**",
        " * Authenticate a user with email and password.",
        " */",
        "export function login(email: string, password: string): boolean {",
        "  return email.length > 0 && password.length > 0;",
        "}",
        "",
        "export function logout(): void {}",
        "",
      ].join("\n"),
    );

    const loaded = loadEffectiveConfig({ targetDir: root });
    const scan = await collectStructuralScan(
      root,
      {
        timeoutMs: loaded.config.timeoutMs,
        maxDepth: loaded.config.maxDepth,
        maxFileSizeBytes: loaded.config.maxFileSizeBytes,
        excludes: [...loaded.config.exclude],
      },
      { filter: loaded.config.filter, trackTypes: loaded.config.trackTypes },
    );

    const extract = scan.extracts.find((item) => item.file === "src/auth/login.ts");
    expect(extract).toBeDefined();

    const login = extract?.exports.find((item) => item.name === "login");
    const logout = extract?.exports.find((item) => item.name === "logout");

    expect(login?.doc).toContain("Authenticate a user");
    expect(login?.signature).toContain("login(email, password)");
    expect(logout?.doc).toBeUndefined();

    const snapshot = generateDualOutput(scan.extracts, "dual", root, {
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const entry = snapshot.entries.find((item) => item.tech.includes("login"));
    expect(entry?.doc).toContain("Authenticate a user");
    expect(entry?.ref).toMatch(/^\[src\/auth\/login\.ts:\d+(?::\d+)?\]$/);
  });

  it("never invents documentation for an undocumented export", async () => {
    const root = await makeTempDir("memolog-docs-missing-");
    await writeFile(root, "src/utils/clip.ts", "export function clip(value: string) { return value.slice(0, 1); }\n");

    const loaded = loadEffectiveConfig({ targetDir: root });
    const scan = await collectStructuralScan(
      root,
      {
        timeoutMs: loaded.config.timeoutMs,
        maxDepth: loaded.config.maxDepth,
        maxFileSizeBytes: loaded.config.maxFileSizeBytes,
        excludes: [...loaded.config.exclude],
      },
      { filter: loaded.config.filter, trackTypes: loaded.config.trackTypes },
    );

    const extract = scan.extracts.find((item) => item.file === "src/utils/clip.ts");
    expect(extract?.exports.length).toBeGreaterThan(0);
    expect(extract?.exports.every((item) => item.doc === undefined)).toBe(true);

    const snapshot = generateDualOutput(scan.extracts, "tech", root, {
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(snapshot.entries.every((item) => item.doc === undefined)).toBe(true);
  });
});
