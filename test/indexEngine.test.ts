import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";
import {
  INDEX_SCHEMA_VERSION,
  indexDbPath,
  openIndexDatabase,
} from "../src/engine/indexSchema.js";
import { IndexStore } from "../src/engine/indexStore.js";
import { TsIndexEngine } from "../src/engine/tsIndexEngine.js";
import { callMcpTool } from "../src/mcp/tools.js";

const tempDirs: string[] = [];

async function makeRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memolog-index-"));
  tempDirs.push(root);
  return root;
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function readRows<T>(root: string, sql: string): Promise<T[]> {
  const db = await openIndexDatabase(root);
  try {
    return db.prepare(sql).all() as unknown as T[];
  } finally {
    db.close();
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("TypeScript index engine", () => {
  it("indexes files, symbols, and import/define edges", async () => {
    const root = await makeRepo();
    await write(
      root,
      "src/auth/login.ts",
      [
        'import { format } from "../utils/format";',
        "export function login(email: string) { return format(email); }",
        'export const version = "1";',
        "",
      ].join("\n"),
    );
    await write(
      root,
      "src/utils/format.ts",
      "export function format(value: string) { return value.trim(); }\n",
    );

    const engine = new TsIndexEngine();
    expect(engine.version()).toEqual({ engine: "ts", schema: INDEX_SCHEMA_VERSION });

    const changes = await engine.index(root);
    expect(changes.files).toEqual([
      { path: "src/auth/login.ts", changeType: "ADDED" },
      { path: "src/utils/format.ts", changeType: "ADDED" },
    ]);
    expect(changes.exports_added).toEqual([
      { path: "src/auth/login.ts", name: "login" },
      { path: "src/auth/login.ts", name: "version" },
      { path: "src/utils/format.ts", name: "format" },
    ]);
    expect(changes.warnings).toEqual([]);

    const files = await readRows<{ path: string; content_hash: string }>(
      root,
      "SELECT path, content_hash FROM files ORDER BY path",
    );
    expect(files.map((row) => row.path)).toEqual([
      "src/auth/login.ts",
      "src/utils/format.ts",
    ]);
    expect(files.every((row) => /^[0-9a-f]{64}$/.test(row.content_hash))).toBe(true);

    const symbols = await readRows<{ path: string; name: string; line: number }>(
      root,
      "SELECT path, name, line FROM symbols ORDER BY path, name",
    );
    expect(symbols).toEqual([
      { path: "src/auth/login.ts", name: "login", line: 2 },
      { path: "src/auth/login.ts", name: "version", line: 3 },
      { path: "src/utils/format.ts", name: "format", line: 1 },
    ]);

    const edges = await readRows<{ src_id: string; dst_id: string; kind: string }>(
      root,
      "SELECT src_id, dst_id, kind FROM edges ORDER BY src_id, dst_id, kind",
    );
    expect(edges).toContainEqual({
      src_id: "File:src/auth/login.ts",
      dst_id: "File:src/utils/format.ts",
      kind: "imports",
    });
    expect(edges).toContainEqual({
      src_id: "File:src/auth/login.ts",
      dst_id: "Symbol:src/auth/login.ts:2:login",
      kind: "defines",
    });

    const db = await openIndexDatabase(root);
    try {
      expect(db.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: INDEX_SCHEMA_VERSION,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM parse_cache").get()).toMatchObject({
        count: 2,
      });
    } finally {
      db.close();
    }
  });

  it("does not store unsupported files (Markdown/JSON) as symbol-less rows", async () => {
    const root = await makeRepo();
    await write(root, "src/a.ts", "export const a = 1;\n");
    await write(root, "README.md", "# docs\n");
    await write(root, "package.json", '{"name":"x"}\n');
    await write(root, "data/config.json", "{}\n");

    const changes = await new TsIndexEngine().index(root);
    expect(changes.files).toEqual([{ path: "src/a.ts", changeType: "ADDED" }]);

    const files = await readRows<{ path: string }>(root, "SELECT path FROM files ORDER BY path");
    expect(files.map((row) => row.path)).toEqual(["src/a.ts"]);
    const cache = await readRows<{ count: number }>(root, "SELECT COUNT(*) AS count FROM parse_cache");
    expect(cache[0]?.count).toBe(1);
  });

  it("removes rows an older build stored for unsupported files", async () => {
    const root = await makeRepo();
    await write(root, "src/a.ts", "export const a = 1;\n");
    await write(root, "README.md", "# docs\n");
    await new TsIndexEngine().index(root);

    const db = await openIndexDatabase(root);
    try {
      db.prepare(
        "INSERT INTO files (path, content_hash, raw_hash, size, lang, parsed_at_commit, updated_seq, mtime_ms) VALUES ('README.md', 'h', 'h', 7, NULL, NULL, 1, NULL)",
      ).run();
    } finally {
      db.close();
    }

    const changes = await new TsIndexEngine().index(root);
    expect(changes.files).toEqual([{ path: "README.md", changeType: "REMOVED" }]);
    const files = await readRows<{ path: string }>(root, "SELECT path FROM files ORDER BY path");
    expect(files.map((row) => row.path)).toEqual(["src/a.ts"]);
  });

  it("is idempotent, then reports modified and removed files", async () => {
    const root = await makeRepo();
    await write(
      root,
      "src/auth/login.ts",
      "export function login(email: string) { return email; }\n",
    );
    await write(root, "src/utils/format.ts", "export function format(v: string) { return v; }\n");

    const engine = new TsIndexEngine();
    await engine.index(root);

    const second = await engine.index(root);
    expect(second.files).toEqual([]);
    expect(second.exports_added).toEqual([]);
    expect(second.exports_removed).toEqual([]);
    expect(second.exports_changed).toEqual([]);

    await write(
      root,
      "src/auth/login.ts",
      "export function login(email: string, password: string) { return email; }\n",
    );
    const modified = await engine.index(root);
    expect(modified.files).toEqual([
      { path: "src/auth/login.ts", changeType: "MODIFIED" },
    ]);
    expect(modified.exports_changed).toEqual([
      { path: "src/auth/login.ts", name: "login" },
    ]);

    await fs.rm(path.join(root, "src/utils/format.ts"));
    const removed = await engine.index(root);
    expect(removed.files).toEqual([
      { path: "src/utils/format.ts", changeType: "REMOVED" },
    ]);
    expect(removed.exports_removed).toEqual([
      { path: "src/utils/format.ts", name: "format" },
    ]);

    const log = await readRows<{ seq: number; op: string; target_id: string }>(
      root,
      "SELECT seq, op, target_id FROM log ORDER BY seq",
    );
    expect(log.map((row) => row.op)).toEqual([
      "file_added",
      "file_added",
      "file_modified",
      "file_removed",
    ]);
    expect(log.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
  });

  it("produces identical rows for identical trees", async () => {
    const left = await makeRepo();
    const right = await makeRepo();
    for (const root of [left, right]) {
      await write(
        root,
        "src/a.ts",
        'import { b } from "./b";\nexport function a() { return b(); }\n',
      );
      await write(root, "src/b.ts", "export function b() { return 1; }\n");
    }

    const engine = new TsIndexEngine();
    await engine.index(left);
    await engine.index(right);

    // mtime is a local filesystem hint, not part of the logical index.
    const fileColumns =
      "path, content_hash, raw_hash, size, lang, parsed_at_commit, updated_seq";
    const leftFiles = await readRows(left, `SELECT ${fileColumns} FROM files ORDER BY path`);
    const rightFiles = await readRows(right, `SELECT ${fileColumns} FROM files ORDER BY path`);
    expect(rightFiles).toEqual(leftFiles);

    const leftSymbols = await readRows(left, "SELECT * FROM symbols ORDER BY id");
    const rightSymbols = await readRows(right, "SELECT * FROM symbols ORDER BY id");
    expect(rightSymbols).toEqual(leftSymbols);

    const leftEdges = await readRows(left, "SELECT * FROM edges ORDER BY src_id, dst_id, kind");
    const rightEdges = await readRows(right, "SELECT * FROM edges ORDER BY src_id, dst_id, kind");
    expect(rightEdges).toEqual(leftEdges);
  });

  it("exposes index through the CLI with deterministic JSON", async () => {
    const root = await makeRepo();
    await runCli(["init", root]);
    await write(root, "src/login.ts", "export function login() {}\n");

    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli(["index", root, "--json"]);
    } finally {
      process.stdout.write = original;
    }

    const payload = JSON.parse(chunks.join("").trim()) as {
      kind: string;
      schema: number;
      engine: string;
      db: string;
      files: Array<{ path: string; changeType: string }>;
    };
    expect(payload.kind).toBe("memo-log-index");
    expect(payload.schema).toBe(INDEX_SCHEMA_VERSION);
    expect(payload.engine).toBe("ts");
    expect(payload.db).toBe(indexDbPath(await fs.realpath(root)));
    expect(payload.files).toEqual([{ path: "src/login.ts", changeType: "ADDED" }]);

    const db = new DatabaseSync(indexDbPath(root));
    try {
      expect(db.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: INDEX_SCHEMA_VERSION,
      });
    } finally {
      db.close();
    }
  });

  it("rejects a newer database schema instead of writing through it", async () => {
    const root = await makeRepo();
    await fs.mkdir(path.join(root, ".memo-log"), { recursive: true });
    const db = new DatabaseSync(indexDbPath(root));
    db.exec("PRAGMA user_version = 999");
    db.close();

    await expect(openIndexDatabase(root)).rejects.toThrow(/newer than this memo-log build/);
  });

  it("skips files whose size/mtime hint is unchanged and --rebuild re-reads them", async () => {
    const root = await makeRepo();
    const file = path.join(root, "src/a.ts");
    await write(root, "src/a.ts", "export const a = 1;\n");

    const engine = new TsIndexEngine();
    await engine.index(root);

    // Same length, different content. Point the stored hint at the new stat so
    // the engine believes the file is unchanged.
    await write(root, "src/a.ts", "export const a = 2;\n");
    const stat = await fs.stat(file);
    const db = await openIndexDatabase(root);
    try {
      db.prepare("UPDATE files SET mtime_ms = ?, size = ? WHERE path = ?").run(
        stat.mtimeMs,
        stat.size,
        "src/a.ts",
      );
    } finally {
      db.close();
    }

    const skipped = await engine.index(root);
    expect(skipped.files).toEqual([]);

    const rebuilt = await engine.index(root, { rebuild: true });
    expect(rebuilt.files).toEqual([{ path: "src/a.ts", changeType: "MODIFIED" }]);
  });

  it("migrates a v1 index by adding the mtime column", async () => {
    const root = await makeRepo();
    await fs.mkdir(path.join(root, ".memo-log"), { recursive: true });
    const db = new DatabaseSync(indexDbPath(root));
    db.exec(
      "CREATE TABLE files (" +
        "path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, raw_hash TEXT NOT NULL, " +
        "size INTEGER NOT NULL, lang TEXT, parsed_at_commit TEXT, updated_seq INTEGER NOT NULL)",
    );
    db.exec("PRAGMA user_version = 1");
    db.close();

    const opened = await openIndexDatabase(root);
    try {
      const columns = opened
        .prepare("PRAGMA table_info(files)")
        .all()
        .map((row) => String(row["name"]));
      expect(columns).toContain("mtime_ms");
      expect(opened.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: INDEX_SCHEMA_VERSION,
      });
    } finally {
      opened.close();
    }
  });

  it("exposes a long-lived read handle for the index", async () => {
    const root = await makeRepo();
    await write(
      root,
      "src/a.ts",
      'import { b } from "./b";\nexport function a() { return b(); }\n',
    );
    await write(root, "src/b.ts", "export function b() { return 1; }\n");
    await new TsIndexEngine().index(root);

    const store = await IndexStore.open(root);
    expect(store).not.toBeNull();
    try {
      expect(store!.status()).toMatchObject({
        schema: INDEX_SCHEMA_VERSION,
        files: 2,
        symbols: 2,
        edges: 3,
      });
      expect(store!.symbols("src/a.ts").map((symbol) => symbol.name)).toEqual(["a"]);
      expect(store!.dependencies("src/a.ts")).toEqual(["src/b.ts"]);
      expect(store!.dependents("src/b.ts")).toEqual(["src/a.ts"]);
    } finally {
      store!.close();
    }
  });

  it("reports the held index on MCP tool payloads", async () => {
    const root = await makeRepo();
    await write(root, "src/a.ts", "export function a() { return 1; }\n");
    await new TsIndexEngine().index(root);

    const store = await IndexStore.open(root);
    expect(store).not.toBeNull();
    try {
      const payload = (await callMcpTool(
        "list_recent_tickets",
        { limit: 1 },
        { rootDir: root, allowWrites: false, index: store! },
      )) as { index?: { schema: number; files: number } };
      expect(payload.index).toMatchObject({
        schema: INDEX_SCHEMA_VERSION,
        files: 1,
      });
    } finally {
      store!.close();
    }
  });

  it("preserves previously indexed rows and reports warnings when a subdirectory becomes unreadable", async () => {
    if (process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0)) {
      return;
    }
    const root = await makeRepo();
    await write(root, "src/public.ts", 'import { secret } from "./protected/secret.js";\nexport const p = secret();\n');
    await write(root, "src/protected/secret.ts", "export function secret() { return 1; }\n");

    const engine = new TsIndexEngine();
    const initial = await engine.index(root);
    expect(initial.files).toHaveLength(2);

    const protectedDir = path.join(root, "src/protected");
    await fs.chmod(protectedDir, 0o000);
    try {
      const second = await engine.index(root);
      expect(second.files).toEqual([]);
      expect(second.warnings.some((w) => w.includes("PERMISSION_DENIED"))).toBe(true);

      const files = await readRows<{ path: string }>(root, "SELECT path FROM files ORDER BY path");
      expect(files.map((row) => row.path)).toEqual(["src/protected/secret.ts", "src/public.ts"]);

      const edges = await readRows<{ src_id: string; dst_id: string; kind: string }>(
        root,
        "SELECT src_id, dst_id, kind FROM edges WHERE kind = 'imports'",
      );
      expect(edges).toEqual([
        {
          src_id: "File:src/public.ts",
          dst_id: "File:src/protected/secret.ts",
          kind: "imports",
        },
      ]);
    } finally {
      await fs.chmod(protectedDir, 0o755);
    }
  });

  it("surfaces walker warnings for oversized files", async () => {
    const root = await makeRepo();
    await write(root, "src/small.ts", "export const small = 1;\n");
    await write(root, "src/oversized.ts", `export const big = 1;\n${"// padding\n".repeat(220_000)}`);

    const changes = await new TsIndexEngine().index(root);
    expect(changes.files).toEqual([{ path: "src/small.ts", changeType: "ADDED" }]);
    expect(changes.warnings.some((w) => w.includes("SKIPPED_LARGE_FILE"))).toBe(true);
  });
});
