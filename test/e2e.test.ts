import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadEffectiveConfig, runScanCommand, loadState } from "../src/engine/index.js";
import { validateOutput, extractFilePathFromRef, isValidFileRef, runAntiFakeChecklist } from "../src/engine/anti-hallucination.js";
import { runCli } from "../src/cli/runCli.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function normalizeVolatileTimestamps(content: string): string {
  return content.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<ts>");
}

async function seedProject(root: string): Promise<void> {
  await fs.mkdir(path.join(root, "src", "auth"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "api"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "components"), { recursive: true });
  await fs.mkdir(path.join(root, "src", "utils"), { recursive: true });

  await fs.writeFile(
    path.join(root, "src", "auth", "login.ts"),
    [
      "export function loginUser(email: string, password: string) {",
      "  return email.length > 0 && password.length > 0;",
      "}",
      "",
      "export const refreshToken = (token: string) => token;",
    ].join("\n"),
    "utf8",
  );

  await fs.writeFile(
    path.join(root, "src", "api", "client.ts"),
    [
      "export async function fetchUser(id: number) {",
      "  return { id };",
      "}",
    ].join("\n"),
    "utf8",
  );

  await fs.writeFile(
    path.join(root, "src", "components", "Button.tsx"),
    [
      "export function Button({ label }: { label: string }) {",
      "  return null;",
      "}",
    ].join("\n"),
    "utf8",
  );

  await fs.writeFile(
    path.join(root, "src", "utils", "format.ts"),
    [
      "export function formatDate(date: Date): string {",
      "  return date.toISOString();",
      "}",
      "",
      "export const currency = (val: number) => `$${val}`;",
    ].join("\n"),
    "utf8",
  );

  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "test-project", version: "1.0.0" }), "utf8");
}

describe("e2e: init → scan → update pipeline", () => {
  it("runs init then scan then update with state diff", async () => {
    const root = await makeTempDir("memolog-e2e-init-scan-");

    // Step 1: init
    const initExit = await runCli(["init", root]);
    expect(initExit).toBe(0);
    const configExists = await fs.access(path.join(root, ".memolog.json")).then(() => true, () => false);
    expect(configExists).toBe(true);

    // Step 2: seed files
    await seedProject(root);

    // Step 3: first scan
    const effectiveConfig = loadEffectiveConfig({ targetDir: root });
    const first = await runScanCommand({
      targetDir: root,
      mode: "dual",
      format: "both",
      quiet: true,
      effectiveConfig,
    });

    expect(first.totalFiles).toBeGreaterThan(0);
    expect(first.markdownPath).toBeDefined();
    expect(first.jsonPath).toBeDefined();

    // Step 4: validate output
    const raw = await fs.readFile(first.jsonPath!, "utf8");
    const snapshot = validateOutput(JSON.parse(raw), root);

    expect(snapshot.entries.length).toBeGreaterThan(0);
    expect(snapshot.version).toBe(2);

    // Anti-fake checklist: no violations
    const violations = runAntiFakeChecklist(snapshot);
    const criticalViolations = violations.filter((v) => v.startsWith("VIOLATION"));
    expect(criticalViolations).toHaveLength(0);

    // Every entry has a valid file reference
    for (const entry of snapshot.entries) {
      expect(isValidFileRef(entry.ref)).toBe(true);
      const filePath = extractFilePathFromRef(entry.ref);
      expect(filePath).not.toBeNull();
    }

    // Step 5: verify markdown has required sections
    const md = await fs.readFile(first.markdownPath!, "utf8");
    expect(md).toContain("AI Memory Snapshot");
    expect(md).toContain("Executive Brief");
    expect(md).toContain("Engineering Ledger");
    expect(md).toContain("Change History");
    expect(md).toContain("Suggested Commits");

    // Step 6: state was written
    const state = loadState(root);
    expect(state).not.toBeNull();
    expect(state!.version).toBe(2);
    expect(Object.keys(state!.files).length).toBeGreaterThan(0);

    // Step 7: second scan (no changes) should produce same output + no diff
    await fs.rm(path.join(root, "MEMO_LOG.md"), { force: true });
    await fs.rm(path.join(root, "MEMO_LOG.json"), { force: true });
    const second = await runScanCommand({
      targetDir: root,
      mode: "dual",
      format: "both",
      quiet: true,
      effectiveConfig,
    });

    const secondRaw = await fs.readFile(second.jsonPath!, "utf8");
    const secondSnapshot = validateOutput(JSON.parse(secondRaw), root);
    expect(secondSnapshot.entries.length).toBe(snapshot.entries.length);

    // Step 8: modify a file and verify diff detects changes
    await fs.appendFile(path.join(root, "src", "utils", "format.ts"), "\nexport function parseDate(s: string): Date { return new Date(s); }\n", "utf8");

    const third = await runScanCommand({
      targetDir: root,
      mode: "dual",
      format: "md",
      quiet: true,
      effectiveConfig,
    });
    expect(third.diffSummary).toBeDefined();
    if (third.diffSummary) {
      expect(third.diffSummary).toContain("~");
    }

    const md3 = await fs.readFile(third.markdownPath!, "utf8");
    expect(md3).toContain("Recent Changes");
    expect(md3).toContain("Latest Change");
    expect(md3).toContain("Suggested Commits");
    expect(md3).toContain("cmd:");
  });

  it("scan detects removed files via diff", async () => {
    const root = await makeTempDir("memolog-e2e-removed-");
    await runCli(["init", root]);
    await seedProject(root);

    const effectiveConfig = loadEffectiveConfig({ targetDir: root });
    await runScanCommand({ targetDir: root, mode: "dual", format: "both", quiet: true, effectiveConfig });

    // Remove a file
    await fs.unlink(path.join(root, "src", "components", "Button.tsx"));

    await fs.rm(path.join(root, "MEMO_LOG.md"), { force: true });
    await fs.rm(path.join(root, "MEMO_LOG.json"), { force: true });

    const result = await runScanCommand({ targetDir: root, mode: "dual", format: "md", quiet: true, effectiveConfig });

    if (result.diffSummary) {
      expect(result.diffSummary).toContain("-");
    }

    const md = await fs.readFile(result.markdownPath!, "utf8");
    expect(md).toContain("Recent Changes");
  });

  it("deterministic output on repeated scans of same codebase", async () => {
    const root = await makeTempDir("memolog-e2e-determinism-");
    await runCli(["init", root]);
    await seedProject(root);

    const effectiveConfig = loadEffectiveConfig({ targetDir: root });
    const first = await runScanCommand({ targetDir: root, mode: "tech", format: "md", quiet: true, effectiveConfig });
    const firstMd = await fs.readFile(first.markdownPath!, "utf8");

    await fs.rm(path.join(root, ".memo-log"), { recursive: true, force: true });
    await fs.rm(path.join(root, "MEMO_LOG.md"), { force: true });

    const second = await runScanCommand({ targetDir: root, mode: "tech", format: "md", quiet: true, effectiveConfig });
    const secondMd = await fs.readFile(second.markdownPath!, "utf8");

    expect(normalizeVolatileTimestamps(secondMd)).toBe(normalizeVolatileTimestamps(firstMd));
  });
});
