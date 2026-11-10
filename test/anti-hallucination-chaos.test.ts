import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadEffectiveConfig, runScanCommand } from "../src/engine/index.js";
import { isValidFileRef, validateOutput, extractFilePathFromRef } from "../src/engine/anti-hallucination.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function normalizeVolatileTimestamps(content: string): string {
  return content.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<ts>");
}

async function seedChaosRepository(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "api"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "components"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "deep", "a", "b", "c", "d", "e"), { recursive: true });

  await fs.writeFile(
    path.join(root, "src", "auth", "login.ts"),
    [
      "export function loginUser(email: string) {",
      "  return email.length > 0;",
      "}",
      "",
      "export const refreshToken = () => true;",
    ].join("\n"),
    "utf8",
  );

  await fs.writeFile(
    path.join(root, "src", "api", "$client.ts"),
    [
      "export async function fetchWithRetry(url: string) {",
      "  return { ok: Boolean(url) };",
      "}",
    ].join("\n"),
    "utf8",
  );

  await fs.writeFile(
    path.join(root, "src", "components", "Dashboard.tsx"),
    [
      "export function DashboardPanel() {",
      "  return null;",
      "}",
    ].join("\n"),
    "utf8",
  );

  await fs.writeFile(
    path.join(root, "src", "deep", "a", "b", "c", "d", "e", "util.ts"),
    [
      "export const normalizeValue = (value: string) => value.trim();",
    ].join("\n"),
    "utf8",
  );

  await fs.writeFile(path.join(root, "src", "mixed-language.py"), "def noop():\n  return True\n", "utf8");
  await fs.writeFile(path.join(root, "README.md"), "# chaos\n", "utf8");
}

describe("anti-hallucination chaos validation", () => {
  it("ensures all generated claims are backed by valid [file:line] references", async () => {
    const root = await makeTempDir("memolog-chaos-refs-");
    await seedChaosRepository(root);

    const effectiveConfig = loadEffectiveConfig({ targetDir: root });

    const result = await runScanCommand({
      targetDir: root,
      mode: "dual",
      format: "both",
      quiet: true,
      includeAgentNotes: false,
      effectiveConfig,
    });

    expect(result.jsonPath).toBeDefined();
    expect(result.markdownPath).toBeDefined();

    const raw = await fs.readFile(result.jsonPath!, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const snapshot = validateOutput(parsed, root);

    expect(snapshot.entries.length).toBeGreaterThan(0);

    for (const entry of snapshot.entries) {
      expect(isValidFileRef(entry.ref)).toBe(true);

      const filePath = extractFilePathFromRef(entry.ref);
      expect(filePath).not.toBeNull();
      const absolute = path.resolve(root, filePath!);
      const content = await fs.readFile(absolute, "utf8");
      const totalLines = content.split("\n").length;

      const lineMatch = entry.ref.match(/:(\d+)/);
      expect(lineMatch).not.toBeNull();
      const line = Number.parseInt(lineMatch![1]!, 10);
      expect(line).toBeGreaterThan(0);
      expect(line).toBeLessThanOrEqual(totalLines);
    }
  });

  it("stays deterministic on repeated scans of the same chaos repo", async () => {
    const root = await makeTempDir("memolog-chaos-determinism-");
    await seedChaosRepository(root);

    const effectiveConfig = loadEffectiveConfig({ targetDir: root });

    const first = await runScanCommand({
      targetDir: root,
      mode: "dual",
      format: "md",
      quiet: true,
      includeAgentNotes: false,
      effectiveConfig,
    });
    const firstOutput = await fs.readFile(first.markdownPath!, "utf8");

    await fs.rm(path.join(root, ".memo-log"), { recursive: true, force: true });
    await fs.rm(path.join(root, "MEMO_LOG.md"), { force: true });

    const second = await runScanCommand({
      targetDir: root,
      mode: "dual",
      format: "md",
      quiet: true,
      includeAgentNotes: false,
      effectiveConfig,
    });
    const secondOutput = await fs.readFile(second.markdownPath!, "utf8");

    expect(normalizeVolatileTimestamps(secondOutput)).toBe(normalizeVolatileTimestamps(firstOutput));
  });
});
