// Tests for multi-agent conflict detection 
import { describe, it, expect } from "vitest";
import {
  detectConflicts,
  renderConflictMarkdown,
  validateConflictReport,
  ConflictSeverity,
} from "../src/ui/agent-ui/conflicts.js";
import type { ParsedFile } from "../src/parsers/types.js";

function makeFile(overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path: "src/auth.ts",
    lang: "ts",
    contentHash: "abc",
    exports: [],
    imports: [],
    signatures: [],
    usedFallback: false,
    warnings: [],
    ...overrides,
  };
}

describe("detectConflicts — no conflicts", () => {
  it("returns empty report when both scans are identical", () => {
    const fileA = makeFile({
      exports: [{ name: "loginUser", kind: "function", line: 10, column: 0 }],
      signatures: [{ name: "loginUser", signature: "function loginUser(u, p)", line: 10, column: 0, async: false, generator: false, params: ["u", "p"] }],
    });
    const fileB = makeFile({
      exports: [{ name: "loginUser", kind: "function", line: 10, column: 0 }],
      signatures: [{ name: "loginUser", signature: "function loginUser(u, p)", line: 10, column: 0, async: false, generator: false, params: ["u", "p"] }],
    });
    const report = detectConflicts([fileA], [fileB]);
    expect(report.totalConflicts).toBe(0);
    expect(report.highCount).toBe(0);
  });
});

describe("detectConflicts — HIGH conflict", () => {
  it("flags different signatures for same export", () => {
    const agentA = makeFile({
      exports: [{ name: "loginUser", kind: "function", line: 10, column: 0 }],
      signatures: [{ name: "loginUser", signature: "function loginUser(username, password)", line: 10, column: 0, async: false, generator: false, params: ["username", "password"] }],
    });
    const agentB = makeFile({
      exports: [{ name: "loginUser", kind: "function", line: 10, column: 0 }],
      signatures: [{ name: "loginUser", signature: "function loginUser(credentials: Credentials)", line: 10, column: 0, async: false, generator: false, params: ["credentials"] }],
    });

    const report = detectConflicts([agentA], [agentB]);
    expect(report.highCount).toBeGreaterThan(0);
    const conflict = report.conflicts.find(c => c.exportName === "loginUser");
    expect(conflict).toBeDefined();
    expect(conflict?.severity).toBe(ConflictSeverity.HIGH);
    expect(conflict?.message).toContain("CONFLICT");
  });
});

describe("detectConflicts — MEDIUM conflict", () => {
  it("flags same signature at different line numbers", () => {
    const agentA = makeFile({
      exports: [{ name: "validateToken", kind: "function", line: 5, column: 0 }],
      signatures: [{ name: "validateToken", signature: "function validateToken(t)", line: 5, column: 0, async: false, generator: false, params: ["t"] }],
    });
    const agentB = makeFile({
      exports: [{ name: "validateToken", kind: "function", line: 20, column: 0 }],
      signatures: [{ name: "validateToken", signature: "function validateToken(t)", line: 20, column: 0, async: false, generator: false, params: ["t"] }],
    });

    const report = detectConflicts([agentA], [agentB]);
    const conflict = report.conflicts.find(c => c.exportName === "validateToken");
    expect(conflict?.severity).toBe(ConflictSeverity.MEDIUM);
  });
});

describe("detectConflicts — one-sided export changes", () => {
  it("flags export removed on one side as INFO", () => {
    const agentA = makeFile({
      exports: [{ name: "legacyFn", kind: "function", line: 8, column: 0 }],
      signatures: [{ name: "legacyFn", signature: "function legacyFn()", line: 8, column: 0, async: false, generator: false, params: [] }],
    });
    const agentB = makeFile({ exports: [], signatures: [] });
    const report = detectConflicts([agentA], [agentB]);
    const conflict = report.conflicts.find((c) => c.exportName === "legacyFn");
    expect(conflict?.severity).toBe(ConflictSeverity.INFO);
    expect(conflict?.message).toContain("missing");
  });

  it("flags export added on one side as INFO", () => {
    const agentA = makeFile({ exports: [], signatures: [] });
    const agentB = makeFile({
      exports: [{ name: "newFn", kind: "function", line: 11, column: 0 }],
      signatures: [{ name: "newFn", signature: "function newFn(x)", line: 11, column: 0, async: false, generator: false, params: ["x"] }],
    });
    const report = detectConflicts([agentA], [agentB]);
    const conflict = report.conflicts.find((c) => c.exportName === "newFn");
    expect(conflict?.severity).toBe(ConflictSeverity.INFO);
    expect(conflict?.message).toContain("missing");
  });
});

describe("detectConflicts — determinism", () => {
  it("produces same hash even when scannedAt differs", () => {
    const agentA = makeFile({
      exports: [{ name: "getUser", kind: "function", line: 3, column: 0 }],
      signatures: [{ name: "getUser", signature: "function getUser(id)", line: 3, column: 0, async: false, generator: false, params: ["id"] }],
    });
    const agentB = makeFile({
      exports: [{ name: "getUser", kind: "function", line: 3, column: 0 }],
      signatures: [{ name: "getUser", signature: "function getUser(userId)", line: 3, column: 0, async: false, generator: false, params: ["userId"] }],
    });

    const r1 = detectConflicts([agentA], [agentB], { scannedAt: "2020-01-01T00:00:00.000Z" });
    const r2 = detectConflicts([agentA], [agentB], { scannedAt: "2030-01-01T00:00:00.000Z" });
    expect(r1.hash).toBe(r2.hash);
    expect(r1.scannedAt).not.toBe(r2.scannedAt);
    expect(r1.conflicts).toEqual(r2.conflicts);
    expect(r1.conflicts).toHaveLength(r1.totalConflicts);
  });
});

describe("detectConflicts — resolution suggestions", () => {
  it("includes suggestions when conflicts exist", () => {
    const agentA = makeFile({
      exports: [{ name: "createOrder", kind: "function", line: 1, column: 0 }],
      signatures: [{ name: "createOrder", signature: "function createOrder(a)", line: 1, column: 0, async: false, generator: false, params: ["a"] }],
    });
    const agentB = makeFile({
      exports: [{ name: "createOrder", kind: "function", line: 1, column: 0 }],
      signatures: [{ name: "createOrder", signature: "function createOrder(a, b)", line: 1, column: 0, async: false, generator: false, params: ["a", "b"] }],
    });
    const report = detectConflicts([agentA], [agentB]);
    expect(report.resolutionSuggestions.length).toBeGreaterThan(0);
  });
});

describe("renderConflictMarkdown", () => {
  it("renders no-conflict message when clean", () => {
    const report = detectConflicts([], []);
    const md = renderConflictMarkdown(report);
    expect(md).toContain("No conflicts detected");
  });

  it("renders conflict section with severity", () => {
    const agentA = makeFile({
      exports: [{ name: "logout", kind: "function", line: 5, column: 0 }],
      signatures: [{ name: "logout", signature: "function logout(session)", line: 5, column: 0, async: false, generator: false, params: ["session"] }],
    });
    const agentB = makeFile({
      exports: [{ name: "logout", kind: "function", line: 5, column: 0 }],
      signatures: [{ name: "logout", signature: "function logout(token: string)", line: 5, column: 0, async: false, generator: false, params: ["token"] }],
    });
    const report = detectConflicts([agentA], [agentB]);
    const md = renderConflictMarkdown(report);
    expect(md).toContain("[HIGH]");
    expect(md).toContain("logout");
  });
});

describe("validateConflictReport — Zod schema", () => {
  it("accepts valid report", () => {
    const agentA = makeFile({ exports: [] });
    const agentB = makeFile({ exports: [] });
    const report = detectConflicts([agentA], [agentB]);
    // should not throw
    expect(() => validateConflictReport(report)).not.toThrow();
  });

  it("rejects invalid hash format", () => {
    const report = detectConflicts([], []);
    const invalid = { ...report, hash: "not-a-sha256" };
    expect(() => validateConflictReport(invalid)).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() => validateConflictReport({ totalConflicts: 0 })).toThrow();
  });
});
