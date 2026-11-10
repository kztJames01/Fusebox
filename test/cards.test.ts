import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli/runCli.js";
import {
  addCard,
  cardHash,
  cardsForScope,
  listCards,
  loadCards,
  toPortableCard,
} from "../src/engine/cards.js";
import { buildExportContext, renderExportContextMarkdown } from "../src/cli/exportContext.js";

async function makeRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "memolog-cards-"));
}

describe("typed memory cards (F-9)", () => {
  it("creates deterministic, ref-anchored cards and normalizes file:line", async () => {
    const root = await makeRoot();
    const a = addCard({ rootDir: root, type: "decision", content: "Use zod", refs: ["src/a.ts:3"], scope: "repo" });
    expect(a.id).toMatch(/^C-[0-9a-f]{12}$/);
    expect(a.refs).toEqual(["[src/a.ts:3]"]);

    const other = await makeRoot();
    const b = addCard({ rootDir: other, type: "decision", content: "Use zod", refs: ["[src/a.ts:3]"], scope: "repo" });
    expect(b.id).toBe(a.id);
    expect(cardHash(a)).toBe(cardHash(b));
    expect(() =>
      addCard({ rootDir: root, type: "decision", content: "Use zod", refs: ["src/a.ts:3"], scope: "repo" }),
    ).toThrow(/already exists/);
  });

  it("rejects missing refs, bad refs, and unscoped targets", async () => {
    const root = await makeRoot();
    expect(() => addCard({ rootDir: root, type: "preference", content: "x", refs: [], scope: "repo" })).toThrow(/ref/);
    expect(() => addCard({ rootDir: root, type: "preference", content: "x", refs: ["nope"], scope: "repo" })).toThrow(/Invalid ref/);
    expect(() => addCard({ rootDir: root, type: "preference", content: "x", refs: ["a.ts:1"], scope: "folder" })).toThrow(/--target/);
    expect(() =>
      addCard({ rootDir: root, type: "preference", content: "x", refs: ["a.ts:1"], scope: "folder", scopeTarget: "../out" }),
    ).toThrow(/inside the project/);
  });

  it("replaces explicitly with a link and hides replaced cards by default", async () => {
    const root = await makeRoot();
    const old = addCard({ rootDir: root, type: "convention", content: "tabs", refs: ["a.ts:1"], scope: "repo" });
    const next = addCard({
      rootDir: root, type: "convention", content: "spaces", refs: ["a.ts:1"], scope: "repo", replaces: old.id,
    });
    expect(next.replaces).toBe(old.id);
    expect(loadCards(root).find((c) => c.id === old.id)?.replacedBy).toBe(next.id);
    expect(listCards(root).map((c) => c.id)).toEqual([next.id]);
    expect(listCards(root, { includeReplaced: true })).toHaveLength(2);
    expect(() =>
      addCard({ rootDir: root, type: "convention", content: "x", refs: ["a.ts:1"], scope: "repo", replaces: old.id }),
    ).toThrow(/already replaced/);
  });

  it("resolves scope: repo always, folder by prefix, ticket by id", async () => {
    const root = await makeRoot();
    addCard({ rootDir: root, type: "constraint", content: "repo", refs: ["a.ts:1"], scope: "repo" });
    addCard({ rootDir: root, type: "decision", content: "auth", refs: ["a.ts:1"], scope: "folder", scopeTarget: "src/auth" });
    addCard({ rootDir: root, type: "decision", content: "tkt", refs: ["a.ts:1"], scope: "ticket", scopeTarget: "T-0123456789ab" });
    expect(cardsForScope(root, {}).map((c) => c.content)).toEqual(["repo"]);
    expect(cardsForScope(root, { file: "src/auth/login.ts" }).map((c) => c.content)).toEqual(["repo", "auth"]);
    expect(cardsForScope(root, { file: "src/authx/y.ts" }).map((c) => c.content)).toEqual(["repo"]);
    expect(cardsForScope(root, { ticketId: "T-0123456789ab" }).map((c) => c.content)).toContain("tkt");
  });

  it("injects cards into context packs within the budget", async () => {
    const root = await makeRoot();
    const card = addCard({ rootDir: root, type: "constraint", content: "No network", refs: ["a.ts:1"], scope: "repo" });
    const pack = buildExportContext({ entries: [] }, { cards: [toPortableCard(card)] });
    expect(pack.cards?.[0]?.hash).toBe(cardHash(card));
    expect(renderExportContextMarkdown(pack)).toContain("## Project cards");
    expect(buildExportContext({ entries: [] }).cards).toBeUndefined();
  });

  it("works through the CLI", async () => {
    const root = await makeRoot();
    await runCli(["init", root]);
    expect(
      await runCli([
        "card", "add", "--type", "preference", "--content", "Prefer named exports",
        "--ref", "src/a.ts:12", "-C", root,
      ]),
    ).toBe(0);
    expect(await runCli(["card", "add", "--type", "preference", "--content", "x", "-C", root])).toBe(2);
    expect(loadCards(root)).toHaveLength(1);
    expect(await runCli(["card", "list", "--json", "-C", root])).toBe(0);
  });
});
