import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { dumpIndex, serializeIndexDump } from "../src/engine/indexDump.js";
import { openIndexDatabase } from "../src/engine/indexSchema.js";
import { TsIndexEngine } from "../src/engine/tsIndexEngine.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "index-parity");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function dumpFixture(name: string, rebuild = false): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memolog-parity-"));
  tempDirs.push(tmp);
  await fs.cp(path.join(fixturesDir, name, "repo"), tmp, { recursive: true });
  const engine = new TsIndexEngine();
  await engine.index(tmp);
  if (rebuild) {
    await engine.index(tmp, { rebuild: true });
  }
  const db = await openIndexDatabase(tmp);
  try {
    return serializeIndexDump(dumpIndex(db));
  } finally {
    db.close();
  }
}

const cases = (await fs.readdir(fixturesDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("index parity corpus", () => {
  it("has the fixture cases the spec requires", () => {
    expect(cases).toEqual(["legacy-state", "missing-signatures", "multi-lang", "path-normalization"]);
  });

  for (const name of cases) {
    it(`${name}: matches the golden dump byte-for-byte`, async () => {
      const expected = await fs.readFile(path.join(fixturesDir, name, "expected.json"), "utf8");
      expect(await dumpFixture(name)).toBe(expected);
    });

    it(`${name}: a warm --rebuild run yields the same dump`, async () => {
      const expected = await fs.readFile(path.join(fixturesDir, name, "expected.json"), "utf8");
      expect(await dumpFixture(name, true)).toBe(expected);
    });
  }

  it("never stores Markdown, JSON, or legacy state files", async () => {
    for (const name of cases) {
      const dump = JSON.parse(await fs.readFile(path.join(fixturesDir, name, "expected.json"), "utf8")) as {
        files: Array<{ path: string }>;
      };
      for (const file of dump.files) {
        expect(file.path).not.toMatch(/\.(md|json)$/);
      }
    }
  });
});
