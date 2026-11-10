import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assertPathWithinRoot, safeReadFile, walkDirectory } from "../src/security/index.js";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("security traversal", () => {
  it("rejects path escape attempts with containment checks", async () => {
    const root = await makeTempDir("memolog-security-root-");
    const outside = await makeTempDir("memolog-security-outside-");

    expect(() => assertPathWithinRoot(root, outside)).toThrow();
  });

  it("rejects parent traversal segments even when string points under root", async () => {
    const root = await makeTempDir("memolog-security-parent-");
    const craftedPath = `${root}/src/../secret.ts`;
    expect(() => assertPathWithinRoot(root, craftedPath)).toThrow();
  });

  it("warns and skips symlink escapes", async () => {
    const root = await makeTempDir("memolog-security-symlink-root-");
    const outside = await makeTempDir("memolog-security-symlink-outside-");

    const outsideFile = path.join(outside, "secret.ts");
    await fs.writeFile(outsideFile, "export const secret = true;\n", "utf8");

    const symlinkPath = path.join(root, "external-link");
    await fs.symlink(outsideFile, symlinkPath);

    const manifest = await walkDirectory({ rootPath: root });
    expect(manifest.structuredWarnings.some((w) => w.code === "SYMLINK_ESCAPE")).toBe(
      true
    );
    expect(manifest.files.length).toBe(0);
  });

  it("respects .gitignore and custom excludes", async () => {
    const root = await makeTempDir("memolog-security-ignore-");
    await fs.writeFile(path.join(root, ".gitignore"), "ignored-dir/\nignored.ts\n", "utf8");
    await fs.mkdir(path.join(root, "ignored-dir"), { recursive: true });
    await fs.mkdir(path.join(root, "keep"), { recursive: true });
    await fs.writeFile(path.join(root, "ignored-dir", "a.ts"), "a", "utf8");
    await fs.writeFile(path.join(root, "ignored.ts"), "b", "utf8");
    await fs.writeFile(path.join(root, "keep", "k.ts"), "c", "utf8");
    await fs.writeFile(path.join(root, "custom.tmp"), "tmp", "utf8");

    const manifest = await walkDirectory({
      rootPath: root,
      excludes: ["*.tmp"]
    });

    const relativePaths = manifest.entries.map((entry) => entry.relativePath);
    expect(relativePaths).toContain("keep/k.ts");
    expect(relativePaths).not.toContain("ignored.ts");
    expect(relativePaths).not.toContain("ignored-dir/a.ts");
    expect(relativePaths).not.toContain("custom.tmp");
  });

  it("skips oversized files with warning", async () => {
    const root = await makeTempDir("memolog-security-large-");
    const hugeFile = path.join(root, "huge.ts");
    await fs.writeFile(hugeFile, "x".repeat(2000), "utf8");
    await fs.writeFile(path.join(root, "small.ts"), "export const x = 1;", "utf8");

    const manifest = await walkDirectory({
      rootPath: root,
      maxFileSizeBytes: 1000
    });

    const relativePaths = manifest.entries.map((entry) => entry.relativePath);
    expect(relativePaths).toContain("small.ts");
    expect(relativePaths).not.toContain("huge.ts");
    expect(
      manifest.structuredWarnings.some((warning) => warning.code === "SKIPPED_LARGE_FILE")
    ).toBe(true);
  });

  it("rejects a symlink that escapes the scan root at read time", async () => {
    const root = await makeTempDir("memolog-security-read-link-");
    const outside = await makeTempDir("memolog-security-read-outside-");
    const outsideFile = path.join(outside, "secret.ts");
    await fs.writeFile(outsideFile, "export const secret = true;\n", "utf8");
    const linkPath = path.join(root, "leak.ts");
    await fs.symlink(outsideFile, linkPath);

    await expect(safeReadFile(linkPath, { rootPath: root })).rejects.toThrow("SYMLINK_ESCAPE");
  });

  it("fails safeReadFile when discovered size does not match read-time size", async () => {
    const root = await makeTempDir("memolog-security-toc-");
    const filePath = path.join(root, "module.ts");
    await fs.writeFile(filePath, "export const value = 1;\n", "utf8");

    await expect(
      safeReadFile(filePath, { expectedSize: 1 })
    ).rejects.toThrow("FILE_SIZE_MISMATCH");
  });

  it("skips sensitive files like credentials, secrets, keys, pems", async () => {
    const root = await makeTempDir("memolog-security-sensitive-");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "ok.ts"), "export const ok = 1;\n", "utf8");
    await fs.writeFile(path.join(root, "credentials.ts"), "export const secret = 1;\n", "utf8");
    await fs.writeFile(path.join(root, "secrets.json"), "{}\n", "utf8");
    await fs.writeFile(path.join(root, "id_rsa.key"), "nope\n", "utf8");
    await fs.writeFile(path.join(root, "cert.pem"), "nope\n", "utf8");

    const manifest = await walkDirectory({ rootPath: root });
    const relativePaths = manifest.entries.map((entry) => entry.relativePath);
    expect(relativePaths).toContain("src/ok.ts");
    expect(relativePaths).not.toContain("credentials.ts");
    expect(relativePaths).not.toContain("secrets.json");
    expect(relativePaths).not.toContain("id_rsa.key");
    expect(relativePaths).not.toContain("cert.pem");
  });
});
