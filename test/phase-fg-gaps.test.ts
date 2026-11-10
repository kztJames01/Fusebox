import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";

import { describe, expect, it } from "vitest";

import { assertServeHost, startServe } from "../src/engine/serve.js";
import { createTicketId } from "../src/engine/tickets.js";
import { parseTicketAction } from "../src/engine/ticketCommands.js";
import type { DiffResult } from "../src/engine/diff.js";
import type { Session } from "../src/types/ticket.js";

const session = {
  version: 1,
  id: "S-0123456789ab",
  status: "active",
  startedAt: "2026-01-01T00:00:00.000Z",
  baselineStatePath: ".memo-log/sessions/S-0123456789ab.baseline.json",
} satisfies Session;

const diff = {
  changes: [{ path: "src/a.ts", changeType: "MODIFIED" }],
} as DiffResult;

describe("phase F gaps", () => {
  it("keeps ticket ids stable without a base commit and changes them when one is present", () => {
    const plain = createTicketId(session, diff, []);
    const again = createTicketId(session, diff, [], "");
    const committed = createTicketId(session, diff, [], "a".repeat(40));
    expect(plain).toBe(again);
    expect(committed).toMatch(/^T-[0-9a-f]{12}$/);
    expect(committed).not.toBe(plain);
  });

  it("treats bounce as the block action used by the review page", () => {
    expect(parseTicketAction("bounce")).toBe("block");
  });

  it("refuses a non-loopback serve bind", () => {
    expect(() => assertServeHost("0.0.0.0")).toThrow(/refuses to bind/);
  });

  it("answers ping on loopback", async () => {
    const root = mkdtempSync(join(tmpdir(), "memolog-serve-"));
    const handle = await startServe({ rootDir: root, host: "127.0.0.1", port: 0 });
    const port = Number(handle.address.split(":")[1]);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString("utf8");
        if (data.includes("\n")) {
          socket.end();
          resolve(data);
        }
      });
      socket.on("error", reject);
      socket.write('{"op":"ping"}\n');
    });
    await handle.close();
    expect(JSON.parse(response)).toEqual({ ok: true, op: "ping" });
  });
});
