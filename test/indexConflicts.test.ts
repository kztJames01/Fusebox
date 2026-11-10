import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openIndexDatabase, type SqliteDatabase } from "../src/engine/indexSchema.js";
import {
  compareAndSwapSymbol,
  detectIndexConflicts,
  endSession,
  recordRead,
  startSession,
} from "../src/engine/indexConflicts.js";
import { TsIndexEngine } from "../src/engine/tsIndexEngine.js";
import type { Card } from "../src/types/cards.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeRepo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "memolog-conflicts-"));
  tempDirs.push(root);
  for (const [relative, content] of Object.entries(files)) {
    await write(root, relative, content);
  }
  return root;
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

const SYMBOL = "Symbol:src/lib.ts:1:compute";

async function withDb<T>(root: string, fn: (db: SqliteDatabase) => Promise<T> | T): Promise<T> {
  const db = await openIndexDatabase(root);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

function currentHash(db: SqliteDatabase): string {
  return String(
    db.prepare("SELECT content_hash FROM symbols WHERE id = ?").get(SYMBOL)?.["content_hash"],
  );
}

const LIB_V1 = "export function compute(a: number): number { return a; }\n";
const LIB_V2 = "export function compute(a: number, b: number): number { return a + b; }\n";

async function indexedRepo(): Promise<string> {
  const root = await makeRepo({
    "src/lib.ts": LIB_V1,
    "src/a.ts": 'import { compute } from "./lib";\nexport const a = compute(1);\n',
    "src/b.ts": 'import { compute } from "./lib";\nexport const b = compute(2);\n',
  });
  await new TsIndexEngine().index(root);
  return root;
}

describe("index conflict rules", () => {
  it("rule 3: breaking change lists importing files", async () => {
    const root = await indexedRepo();
    await write(root, "src/lib.ts", LIB_V2);
    const changes = await new TsIndexEngine().index(root);

    expect(changes.exports_changed).toEqual([{ path: "src/lib.ts", name: "compute" }]);
    expect(changes.conflicts).toEqual([
      {
        kind: "breaking_change",
        path: "src/lib.ts",
        symbol: "compute",
        detail: "Export compute in src/lib.ts was changed; imported by src/a.ts, src/b.ts",
      },
    ]);
  });

  it("rule 3: no conflict when nothing imports the changed file, or only bodies change", async () => {
    const root = await indexedRepo();
    await write(root, "src/a.ts", 'import { compute } from "./lib";\nexport const a = compute(9);\n');
    expect((await new TsIndexEngine().index(root)).conflicts).toEqual([]);
  });

  it("rule 3: caps breaking change caller lists at 10 files with (+N more)", async () => {
    const files: Record<string, string> = { "src/lib.ts": LIB_V1 };
    for (let i = 0; i < 15; i += 1) {
      files[`src/c${String(i).padStart(2, "0")}.ts`] =
        'import { compute } from "./lib.js";\nexport const v = compute(1);\n';
    }
    const root = await makeRepo(files);
    const engine = new TsIndexEngine();
    await engine.index(root);

    await write(root, "src/lib.ts", LIB_V2);
    const changes = await engine.index(root);

    expect(changes.conflicts).toHaveLength(1);
    expect(changes.conflicts[0]?.detail).toContain("(+5 more)");
  });

  it("rule 1: stale read names who changed the symbol", async () => {
    const root = await indexedRepo();
    const sessionId = await withDb(root, (db) => {
      const session = startSession(db, { agent: "agent-a" });
      recordRead(db, session.id, SYMBOL);
      return session.id;
    });
    await write(root, "src/lib.ts", `// edited\n${LIB_V1}`);
    await new TsIndexEngine().index(root);

    // The symbol moved from line 1 to line 2; resolution falls back to path + name.
    const conflicts = await withDb(root, (db) => detectIndexConflicts(db));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      kind: "stale_read",
      path: "src/lib.ts",
      symbol: "compute",
      sessions: [sessionId],
    });
    expect(conflicts[0]?.detail).toContain("an index run (file_modified)");
  });

  it("rule 1: unchanged reads are clean", async () => {
    const root = await indexedRepo();
    const conflicts = await withDb(root, async (db) => {
      const session = startSession(db);
      recordRead(db, session.id, SYMBOL);
      return detectIndexConflicts(db);
    });
    expect(conflicts).toEqual([]);
  });

  it("rule 6: compare-and-swap rejects a mismatched hash and writes nothing", async () => {
    const root = await indexedRepo();
    await withDb(root, (db) => {
      const session = startSession(db);
      const before = Number(db.prepare("SELECT COUNT(*) AS c FROM log").get()?.["c"]);
      const result = compareAndSwapSymbol(db, {
        sessionId: session.id,
        symbolId: SYMBOL,
        expectedHash: "0".repeat(64),
        newHash: "1".repeat(64),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.conflict.kind).toBe("stale_read");
        expect(result.conflict.detail).toContain("Write rejected");
      }
      expect(Number(db.prepare("SELECT COUNT(*) AS c FROM log").get()?.["c"])).toBe(before);
    });
  });

  it("rule 6: accepted write is logged, and a second writer holding the old hash is rejected", async () => {
    const root = await indexedRepo();
    await withDb(root, (db) => {
      const a = startSession(db, { agent: "a" });
      const b = startSession(db, { agent: "b" });
      const seen = currentHash(db);
      recordRead(db, a.id, SYMBOL);
      recordRead(db, b.id, SYMBOL);

      const first = compareAndSwapSymbol(db, {
        sessionId: a.id,
        symbolId: SYMBOL,
        expectedHash: seen,
        newHash: "a".repeat(64),
      });
      expect(first.ok).toBe(true);

      const second = compareAndSwapSymbol(db, {
        sessionId: b.id,
        symbolId: SYMBOL,
        expectedHash: seen,
        newHash: "b".repeat(64),
      });
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.conflict.detail).toContain(`session ${a.id}`);
      }
      // The symbols table is derived from disk and is untouched by a CAS.
      expect(currentHash(db)).toBe(seen);
    });
  });

  it("rule 1: another session's write makes a read stale, the writer's own read stays fresh", async () => {
    const root = await indexedRepo();
    let bId = "";
    const conflicts = await withDb(root, (db) => {
      const a = startSession(db);
      const b = startSession(db);
      bId = b.id;
      const seen = currentHash(db);
      recordRead(db, a.id, SYMBOL);
      recordRead(db, b.id, SYMBOL);
      compareAndSwapSymbol(db, { sessionId: a.id, symbolId: SYMBOL, expectedHash: seen, newHash: "a".repeat(64) });
      return detectIndexConflicts(db);
    });
    expect(conflicts.map((c) => [c.kind, c.sessions])).toEqual([["stale_read", [bId]]]);
  });

  it("rule 2: overlapping sessions editing one symbol are both flagged; sequential ones are not", async () => {
    const root = await indexedRepo();
    await withDb(root, async (db) => {
      const a = startSession(db);
      const b = startSession(db);
      const seen = currentHash(db);
      expect(
        compareAndSwapSymbol(db, { sessionId: a.id, symbolId: SYMBOL, expectedHash: seen, newHash: "a".repeat(64) }).ok,
      ).toBe(true);
      expect(
        compareAndSwapSymbol(db, { sessionId: b.id, symbolId: SYMBOL, expectedHash: "a".repeat(64), newHash: "b".repeat(64) }).ok,
      ).toBe(true);

      const conflicts = await detectIndexConflicts(db);
      const concurrent = conflicts.filter((c) => c.kind === "concurrent_edit");
      expect(concurrent).toHaveLength(1);
      expect(concurrent[0]?.sessions).toEqual([a.id, b.id]);

      // A third session that starts after both ended does not overlap.
      endSession(db, a.id);
      endSession(db, b.id);
      const c = startSession(db);
      compareAndSwapSymbol(db, { sessionId: c.id, symbolId: SYMBOL, expectedHash: "b".repeat(64), newHash: "c".repeat(64) });
      const later = (await detectIndexConflicts(db, { sessionId: c.id })).filter(
        (item) => item.kind === "concurrent_edit",
      );
      expect(later).toEqual([]);
    });
  });

  it("rule 4: a base commit that is not an ancestor of HEAD marks the reads unverified", async () => {
    const root = await indexedRepo();
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    await withDb(root, async (db) => {
      const session = startSession(db, { baseCommit: base });
      recordRead(db, session.id, SYMBOL);

      const drifted = await detectIndexConflicts(db, {
        headSha: head,
        isAncestor: () => Promise.resolve(false),
      });
      expect(drifted).toHaveLength(1);
      expect(drifted[0]).toMatchObject({ kind: "branch_drift", sessions: [session.id] });
      expect(drifted[0]?.detail).toContain("1 read(s) unverified");

      const ok = await detectIndexConflicts(db, {
        headSha: head,
        isAncestor: () => Promise.resolve(true),
      });
      expect(ok).toEqual([]);
    });
  });

  it("rule 5: cards with vanished refs are flagged stale and left untouched", async () => {
    const root = await indexedRepo();
    const card = (id: string, refs: string[]): Card =>
      ({
        id,
        type: "decision",
        content: "x",
        refs,
        scope: "repo",
        createdFrom: "explicit",
        createdAt: "2026-01-01T00:00:00.000Z",
      }) as Card;
    const cards = [
      card("C-000000000002", ["[src/gone.ts:3]"]),
      card("C-000000000001", ["[src/lib.ts:1]", `sha256:${"f".repeat(64)}`]),
    ];
    const conflicts = await withDb(root, (db) => detectIndexConflicts(db, { cards }));
    expect(conflicts.map((c) => c.detail)).toEqual([
      `Card C-000000000001 is stale: sha256:${"f".repeat(64)} matches no indexed file or symbol hash`,
      "Card C-000000000002 is stale: [src/gone.ts:3] points at a file that is not in the index",
    ]);
    expect(cards[0]?.refs).toEqual(["[src/gone.ts:3]"]);
  });

  it("returns conflicts in a stable order across runs", async () => {
    const root = await indexedRepo();
    const run = async (): Promise<string> =>
      withDb(root, async (db) => JSON.stringify(await detectIndexConflicts(db)));
    expect(await run()).toBe(await run());
  });
});
