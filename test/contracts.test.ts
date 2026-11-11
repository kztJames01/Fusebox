/**
 * Validates that the fixture JSON files conform to the versioned contract
 * schemas. These tests run without a Rust binary — they only exercise the
 * JSON structure.
 *
 * Edge-case tests are written first (the "red" cases) followed by the valid
 * cases that make them green.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadFixture(rel: string): unknown {
  return JSON.parse(readFileSync(resolve(root, rel), "utf8"));
}

// ── Minimal structural validators matching the JSON schemas ──────────────────

interface IntentContract {
  schemaVersion: string;
  sessionId: string;
  workspaceRoots: string[];
  networkPolicy: "deny_all" | "allowlist" | "allow";
  approvalPolicy: "deny" | "escalate" | "log";
  readRoots?: string[];
  writeRoots?: string[];
  protectedRoots?: string[];
  allowedCommandClasses?: string[];
  expiresAt?: string | null;
  policyHash?: string | null;
  [key: string]: unknown;
}

interface ExecRequest {
  protocolVersion: string;
  requestId: string;
  sessionId: string;
  executable: string;
  argv: string[];
  cwd: string;
  [key: string]: unknown;
}

interface PolicyDecision {
  verdict: "allow" | "log" | "escalate" | "deny" | "unsupported";
  reasonCode: string;
  resolutionStatus: "resolved" | "partial" | "unsupported";
  userActionRequired: boolean;
  policyHash: string;
  [key: string]: unknown;
}

interface CommandReceipt {
  schemaVersion: string;
  receiptId: string;
  sequence: number;
  recordedAt: string;
  sessionId: string;
  requestId: string;
  requestSummary: {
    executableName: string;
    argc: number;
    cwd: string;
    [key: string]: unknown;
  };
  policyDecision: PolicyDecision;
  enforcement: {
    backend: string;
    applied: boolean;
    [key: string]: unknown;
  };
  processOutcome: {
    state: "denied" | "started" | "completed" | "cancelled" | "failed";
    [key: string]: unknown;
  };
  previousHash: string;
  recordHash: string;
  [key: string]: unknown;
}

function assertIntent(value: unknown): asserts value is IntentContract {
  if (typeof value !== "object" || value === null) {
    throw new Error("not an object");
  }
  const v = value as Record<string, unknown>;
  if (v["schemaVersion"] !== "1") {
    throw new Error(`schemaVersion must be '1', got '${v["schemaVersion"]}'`);
  }
  if (typeof v["sessionId"] !== "string" || v["sessionId"].length === 0) {
    throw new Error("sessionId must be a non-empty string");
  }
  if (!Array.isArray(v["workspaceRoots"])) {
    throw new Error("workspaceRoots must be an array");
  }
  const validNetworkPolicies = ["deny_all", "allowlist", "allow"];
  if (!validNetworkPolicies.includes(v["networkPolicy"] as string)) {
    throw new Error(`invalid networkPolicy: ${v["networkPolicy"]}`);
  }
  const validApprovalPolicies = ["deny", "escalate", "log"];
  if (!validApprovalPolicies.includes(v["approvalPolicy"] as string)) {
    throw new Error(`invalid approvalPolicy: ${v["approvalPolicy"]}`);
  }
}

function assertRequest(value: unknown): asserts value is ExecRequest {
  if (typeof value !== "object" || value === null) {
    throw new Error("not an object");
  }
  const v = value as Record<string, unknown>;
  if (v["protocolVersion"] !== "1") {
    throw new Error(`protocolVersion must be '1'`);
  }
  for (const field of ["requestId", "sessionId", "executable", "cwd"]) {
    if (typeof v[field] !== "string" || (v[field] as string).length === 0) {
      throw new Error(`${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(v["argv"])) {
    throw new Error("argv must be an array");
  }
}

function assertReceipt(value: unknown): asserts value is CommandReceipt {
  if (typeof value !== "object" || value === null) {
    throw new Error("not an object");
  }
  const v = value as Record<string, unknown>;
  if (v["schemaVersion"] !== "1") {
    throw new Error(`schemaVersion must be '1'`);
  }
  for (const field of [
    "receiptId",
    "sessionId",
    "requestId",
    "recordedAt",
    "previousHash",
    "recordHash",
  ]) {
    if (typeof v[field] !== "string") {
      throw new Error(`${field} must be a string`);
    }
  }
  if (typeof v["sequence"] !== "number" || v["sequence"] < 0) {
    throw new Error("sequence must be a non-negative number");
  }
  if (typeof v["requestSummary"] !== "object" || v["requestSummary"] === null) {
    throw new Error("requestSummary must be an object");
  }
  if (typeof v["policyDecision"] !== "object" || v["policyDecision"] === null) {
    throw new Error("policyDecision must be an object");
  }
  const pd = v["policyDecision"] as Record<string, unknown>;
  const validVerdicts = ["allow", "log", "escalate", "deny", "unsupported"];
  if (!validVerdicts.includes(pd["verdict"] as string)) {
    throw new Error(`invalid verdict: ${pd["verdict"]}`);
  }
  if (typeof pd["policyHash"] !== "string") {
    throw new Error("policyDecision.policyHash must be a string");
  }
}

// ── Edge cases (written first — these define the contract boundaries) ─────────

describe("contract edge cases", () => {
  it("rejects an IntentContract missing sessionId", () => {
    const bad = {
      schemaVersion: "1",
      workspaceRoots: ["/p"],
      networkPolicy: "deny_all",
      approvalPolicy: "deny",
    };
    expect(() => assertIntent(bad)).toThrow("sessionId");
  });

  it("rejects an IntentContract with an unknown networkPolicy variant", () => {
    const bad = {
      schemaVersion: "1",
      sessionId: "s",
      workspaceRoots: ["/p"],
      networkPolicy: "unrestricted", // not a valid variant
      approvalPolicy: "deny",
    };
    expect(() => assertIntent(bad)).toThrow("networkPolicy");
  });

  it("rejects an IntentContract with wrong schemaVersion", () => {
    const bad = {
      schemaVersion: "99",
      sessionId: "s",
      workspaceRoots: ["/p"],
      networkPolicy: "deny_all",
      approvalPolicy: "deny",
    };
    expect(() => assertIntent(bad)).toThrow("schemaVersion");
  });

  it("rejects an ExecRequest missing executable", () => {
    const bad = {
      protocolVersion: "1",
      requestId: "r",
      sessionId: "s",
      argv: [],
      cwd: "/p",
      // executable is absent
    };
    expect(() => assertRequest(bad)).toThrow("executable");
  });

  it("rejects an ExecRequest with empty executable", () => {
    const bad = {
      protocolVersion: "1",
      requestId: "r",
      sessionId: "s",
      executable: "", // empty — not a valid path
      argv: [],
      cwd: "/p",
    };
    expect(() => assertRequest(bad)).toThrow("executable");
  });

  it("rejects a CommandReceipt missing schemaVersion", () => {
    const bad = {
      // schemaVersion absent
      receiptId: "r",
      sequence: 0,
      recordedAt: "2026-11-10T00:00:00Z",
      sessionId: "s",
      requestId: "q",
      requestSummary: { executableName: "x", argc: 0, cwd: "/" },
      policyDecision: {
        verdict: "allow",
        reasonCode: "OK",
        resolutionStatus: "resolved",
        userActionRequired: false,
        policyHash: "h",
      },
      enforcement: { backend: "none", applied: false },
      processOutcome: { state: "completed" },
      previousHash: "",
      recordHash: "",
    };
    expect(() => assertReceipt(bad)).toThrow("schemaVersion");
  });

  it("rejects a CommandReceipt with an invalid verdict", () => {
    const bad = {
      schemaVersion: "1",
      receiptId: "r",
      sequence: 0,
      recordedAt: "2026-11-10T00:00:00Z",
      sessionId: "s",
      requestId: "q",
      requestSummary: { executableName: "x", argc: 0, cwd: "/" },
      policyDecision: {
        verdict: "maybe", // invalid
        reasonCode: "OK",
        resolutionStatus: "resolved",
        userActionRequired: false,
        policyHash: "h",
      },
      enforcement: { backend: "none", applied: false },
      processOutcome: { state: "completed" },
      previousHash: "",
      recordHash: "",
    };
    expect(() => assertReceipt(bad)).toThrow("verdict");
  });

  it("rejects a CommandReceipt with a negative sequence", () => {
    const bad = {
      schemaVersion: "1",
      receiptId: "r",
      sequence: -1, // invalid
      recordedAt: "2026-11-10T00:00:00Z",
      sessionId: "s",
      requestId: "q",
      requestSummary: { executableName: "x", argc: 0, cwd: "/" },
      policyDecision: {
        verdict: "allow",
        reasonCode: "OK",
        resolutionStatus: "resolved",
        userActionRequired: false,
        policyHash: "h",
      },
      enforcement: { backend: "none", applied: false },
      processOutcome: { state: "completed" },
      previousHash: "",
      recordHash: "",
    };
    expect(() => assertReceipt(bad)).toThrow("sequence");
  });
});

// ── Valid fixture files ───────────────────────────────────────────────────────

describe("fixture files conform to contracts", () => {
  it("valid-intent.json is a valid IntentContract", () => {
    const data = loadFixture("fixtures/commands/valid-intent.json");
    expect(() => assertIntent(data)).not.toThrow();
  });

  it("valid-intent-with-future-fields.json passes (unknown fields ignored)", () => {
    const data = loadFixture(
      "fixtures/commands/valid-intent-with-future-fields.json"
    );
    expect(() => assertIntent(data)).not.toThrow();
  });

  it("valid-request.json is a valid ExecRequest", () => {
    const data = loadFixture("fixtures/commands/valid-request.json");
    expect(() => assertRequest(data)).not.toThrow();
  });

  it("valid-receipt.json is a valid CommandReceipt", () => {
    const data = loadFixture("fixtures/receipts/valid-receipt.json");
    expect(() => assertReceipt(data)).not.toThrow();
  });

  it("policy-outcomes.json allow verdict is valid", () => {
    const data = loadFixture("fixtures/commands/policy-outcomes.json") as {
      allow: unknown;
    };
    const r: Record<string, unknown> = {
      schemaVersion: "1",
      receiptId: "test",
      sequence: 0,
      recordedAt: "2026-11-10T00:00:00Z",
      sessionId: "s",
      requestId: "q",
      requestSummary: { executableName: "x", argc: 0, cwd: "/" },
      policyDecision: data.allow,
      enforcement: { backend: "none", applied: false },
      processOutcome: { state: "completed" },
      previousHash: "",
      recordHash: "",
    };
    expect(() => assertReceipt(r)).not.toThrow();
  });
});

// ── Adversarial fixture structure ─────────────────────────────────────────────

describe("adversarial fixtures have required fields", () => {
  it("invalid-paths.json is an array with required fields", () => {
    const data = loadFixture("fixtures/adversarial/invalid-paths.json");
    expect(Array.isArray(data)).toBe(true);
    for (const entry of data as unknown[]) {
      const e = entry as Record<string, unknown>;
      expect(typeof e["executable"]).toBe("string");
      expect(Array.isArray(e["argv"])).toBe(true);
      expect(typeof e["expectedVerdict"]).toBe("string");
      expect(typeof e["expectedReasonCode"]).toBe("string");
    }
  });

  it("adversarial paths all have non-empty expectedReasonCode", () => {
    const data = loadFixture("fixtures/adversarial/invalid-paths.json") as Array<{
      expectedReasonCode: string;
    }>;
    for (const entry of data) {
      expect(entry.expectedReasonCode.length).toBeGreaterThan(0);
    }
  });
});
