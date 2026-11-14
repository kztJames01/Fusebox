/**
 * rustCore integration tests: validates the Rust core binary's behavior
 * from the TypeScript layer. These tests only run when the Rust binary
 * has been built (via `npm run rust:build` or CI).
 *
 * Tests skip automatically when the binary is not present.
 */

import { describe, it, expect } from "vitest";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");

async function findBinary(): Promise<string | null> {
  const candidates = [
    resolve(ROOT, "rust", "target", "release", "fusebox"),
    resolve(ROOT, "rust", "target", "debug", "fusebox"),
    resolve(ROOT, "rust", "target", "release", "fusebox.exe"),
    resolve(ROOT, "rust", "target", "debug", "fusebox.exe"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("rustCore — binary smoke tests", { timeout: 15000 }, () => {
  it("version command returns structured JSON with schema_version", async () => {
    const binary = await findBinary();
    if (!binary) {
      console.log("Rust binary not found — skipping");
      return;
    }

    const { stdout } = await execFileAsync(binary, ["version"]);
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(parsed).toHaveProperty("name", "fusebox");
    expect(parsed).toHaveProperty("version");
    expect(parsed).toHaveProperty("schema_version", "1");
  });

  it("capabilities command returns known capabilities array", async () => {
    const binary = await findBinary();
    if (!binary) {
      console.log("Rust binary not found — skipping");
      return;
    }

    const { stdout } = await execFileAsync(binary, ["capabilities"]);
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(Array.isArray(parsed["capabilities"])).toBe(true);
    const caps = parsed["capabilities"] as string[];
    expect(caps).toContain("proxy");
    expect(caps).toContain("init");
    expect(caps).toContain("run");
    expect(caps).toContain("policy");
    // Confinement support must be reported, never inferred.
    expect(parsed["confinement"]).toMatch(/^(none|landlock-v\d+)$/);
  });

  it("unknown subcommand exits non-zero", async () => {
    const binary = await findBinary();
    if (!binary) {
      console.log("Rust binary not found — skipping");
      return;
    }

    let exitCode = 0;
    try {
      await execFileAsync(binary, ["unknown-command-xyz"]);
    } catch (e) {
      exitCode = (e as NodeJS.ErrnoException & { code?: number }).code ?? 1;
    }
    expect(exitCode).not.toBe(0);
  });

  it("binary is present and executable when RUST binary exists", async () => {
    const binary = await findBinary();
    if (!binary) {
      console.log("Rust binary not found — skipping");
      return;
    }
    // Just confirm we can find and run it.
    expect(typeof binary).toBe("string");
    const { stdout } = await execFileAsync(binary, ["version"]);
    expect(stdout.length).toBeGreaterThan(0);
  });
});
