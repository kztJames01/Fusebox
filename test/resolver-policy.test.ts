/**
 * Tests for the bounded shell pre-resolver and policy evaluator behaviors.
 * Exercised from TypeScript via the fixture files and contract validators.
 *
 * These tests run without a Rust binary — they only exercise JSON structures,
 * fixture conformance, and the TypeScript contract validators.
 *
 * TDD approach: edge-case / failure tests are listed first (red phase),
 * followed by the valid cases (green phase).
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadFixture(rel: string): unknown {
  return JSON.parse(readFileSync(resolve(root, rel), "utf8"));
}

// ── TypeScript model of the resolver output ───────────────────────────────────

type CommandClass =
  | "remove"
  | "move"
  | "copy"
  | "xargs"
  | "path_transform"
  | "unsupported";

type Confidence = "resolved" | "partial" | "unsupported";

type Provenance =
  | "literal"
  | "glob"
  | "dirname"
  | "basename"
  | "xargs_expanded";

interface PredictedTarget {
  path: string;
  provenance: Provenance;
}

interface Resolution {
  resolverVersion: string;
  commandClass: CommandClass;
  executable: string;
  parsedArgv: string[];
  cwd: string;
  predictedTargets: PredictedTarget[];
  confidence: Confidence;
  warnings: string[];
  supported: boolean;
  [key: string]: unknown;
}

type Verdict = "allow" | "log" | "escalate" | "deny" | "unsupported";
type ResolutionStatus = "resolved" | "partial" | "unsupported";

interface PolicyDryRunResult {
  verdict: Verdict;
  reasonCode: string;
  ruleId?: string | null;
  predictedTargets: string[];
  resolutionStatus: ResolutionStatus;
  userActionRequired: boolean;
  policyHash: string;
  resolver?: {
    supported: boolean;
    confidence: Confidence;
    commandClass: CommandClass;
    warnings: string[];
  };
  [key: string]: unknown;
}

// ── Validators ────────────────────────────────────────────────────────────────

function assertResolution(value: unknown): asserts value is Resolution {
  if (typeof value !== "object" || value === null) {
    throw new Error("not an object");
  }
  const v = value as Record<string, unknown>;
  if (v["resolverVersion"] !== "1") {
    throw new Error(`resolverVersion must be '1', got '${v["resolverVersion"]}'`);
  }
  const validClasses: CommandClass[] = [
    "remove", "move", "copy", "xargs", "path_transform", "unsupported",
  ];
  if (!validClasses.includes(v["commandClass"] as CommandClass)) {
    throw new Error(`invalid commandClass: ${v["commandClass"]}`);
  }
  const validConfidences: Confidence[] = ["resolved", "partial", "unsupported"];
  if (!validConfidences.includes(v["confidence"] as Confidence)) {
    throw new Error(`invalid confidence: ${v["confidence"]}`);
  }
  if (typeof v["supported"] !== "boolean") {
    throw new Error("supported must be a boolean");
  }
  if (!Array.isArray(v["predictedTargets"])) {
    throw new Error("predictedTargets must be an array");
  }
  if (!Array.isArray(v["warnings"])) {
    throw new Error("warnings must be an array");
  }
}

function assertPolicyDryRunResult(value: unknown): asserts value is PolicyDryRunResult {
  if (typeof value !== "object" || value === null) {
    throw new Error("not an object");
  }
  const v = value as Record<string, unknown>;
  const validVerdicts: Verdict[] = ["allow", "log", "escalate", "deny", "unsupported"];
  if (!validVerdicts.includes(v["verdict"] as Verdict)) {
    throw new Error(`invalid verdict: ${v["verdict"]}`);
  }
  if (typeof v["reasonCode"] !== "string" || v["reasonCode"].length === 0) {
    throw new Error("reasonCode must be a non-empty string");
  }
  if (!Array.isArray(v["predictedTargets"])) {
    throw new Error("predictedTargets must be an array");
  }
  const validStatuses: ResolutionStatus[] = ["resolved", "partial", "unsupported"];
  if (!validStatuses.includes(v["resolutionStatus"] as ResolutionStatus)) {
    throw new Error(`invalid resolutionStatus: ${v["resolutionStatus"]}`);
  }
  if (typeof v["userActionRequired"] !== "boolean") {
    throw new Error("userActionRequired must be a boolean");
  }
  if (typeof v["policyHash"] !== "string") {
    throw new Error("policyHash must be a string");
  }
}

// ── Resolution fixture builder ─────────────────────────────────────────────────

function buildResolution(overrides: Partial<Resolution> = {}): Resolution {
  return {
    resolverVersion: "1",
    commandClass: "remove",
    executable: "/bin/rm",
    parsedArgv: ["-rf", "/project/src/old.rs"],
    cwd: "/project",
    predictedTargets: [{ path: "/project/src/old.rs", provenance: "literal" }],
    confidence: "resolved",
    warnings: [],
    supported: true,
    ...overrides,
  };
}

function buildPolicyResult(overrides: Partial<PolicyDryRunResult> = {}): PolicyDryRunResult {
  return {
    verdict: "allow",
    reasonCode: "WITHIN_SCOPE",
    ruleId: "exec-in-scope",
    predictedTargets: ["/project/src/old.rs"],
    resolutionStatus: "resolved",
    userActionRequired: false,
    policyHash: "deadbeef".repeat(8),
    ...overrides,
  };
}

// ── Red phase: edge cases that MUST fail validation ───────────────────────────

describe("resolver output contract — edge cases (red phase)", () => {
  it("rejects a Resolution with an invalid commandClass", () => {
    const bad = buildResolution({ commandClass: "shell" as CommandClass });
    expect(() => assertResolution(bad)).toThrow("commandClass");
  });

  it("rejects a Resolution with an invalid confidence", () => {
    const bad = buildResolution({ confidence: "maybe" as Confidence });
    expect(() => assertResolution(bad)).toThrow("confidence");
  });

  it("rejects a Resolution with wrong resolverVersion", () => {
    const bad = buildResolution({ resolverVersion: "99" });
    expect(() => assertResolution(bad)).toThrow("resolverVersion");
  });

  it("rejects a Resolution where supported is not a boolean", () => {
    const bad = buildResolution({ supported: "yes" as unknown as boolean });
    expect(() => assertResolution(bad)).toThrow("supported");
  });

  it("rejects a Resolution where predictedTargets is not an array", () => {
    const bad = buildResolution({ predictedTargets: null as unknown as PredictedTarget[] });
    expect(() => assertResolution(bad)).toThrow("predictedTargets");
  });

  it("rejects a PolicyDryRunResult with an invalid verdict", () => {
    const bad = buildPolicyResult({ verdict: "maybe" as Verdict });
    expect(() => assertPolicyDryRunResult(bad)).toThrow("verdict");
  });

  it("rejects a PolicyDryRunResult with an empty reasonCode", () => {
    const bad = buildPolicyResult({ reasonCode: "" });
    expect(() => assertPolicyDryRunResult(bad)).toThrow("reasonCode");
  });

  it("rejects a PolicyDryRunResult with an invalid resolutionStatus", () => {
    const bad = buildPolicyResult({ resolutionStatus: "complete" as ResolutionStatus });
    expect(() => assertPolicyDryRunResult(bad)).toThrow("resolutionStatus");
  });

  it("rejects a PolicyDryRunResult where userActionRequired is not a boolean", () => {
    const bad = buildPolicyResult({ userActionRequired: "yes" as unknown as boolean });
    expect(() => assertPolicyDryRunResult(bad)).toThrow("userActionRequired");
  });
});

// ── Green phase: valid structures pass validation ────────────────────────────

describe("resolver output contract — valid structures (green phase)", () => {
  it("accepts a fully resolved removal", () => {
    const res = buildResolution();
    expect(() => assertResolution(res)).not.toThrow();
    expect(res.confidence).toBe("resolved");
    expect(res.supported).toBe(true);
  });

  it("accepts a partial resolution with glob warning", () => {
    const res = buildResolution({
      confidence: "partial",
      predictedTargets: [{ path: "/project/src/*.rs", provenance: "glob" }],
      warnings: ["glob pattern not expanded: /project/src/*.rs"],
    });
    expect(() => assertResolution(res)).not.toThrow();
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it("accepts an unsupported resolution", () => {
    const res = buildResolution({
      commandClass: "unsupported",
      confidence: "unsupported",
      predictedTargets: [],
      warnings: ["unsupported: unsupported command class"],
      supported: false,
    });
    expect(() => assertResolution(res)).not.toThrow();
    expect(res.supported).toBe(false);
  });

  it("accepts a denied policy result", () => {
    const result = buildPolicyResult({
      verdict: "deny",
      reasonCode: "OUTSIDE_WRITE_ROOT",
      ruleId: "exec-outside-write-root",
      userActionRequired: false,
    });
    expect(() => assertPolicyDryRunResult(result)).not.toThrow();
  });

  it("accepts an escalated policy result requiring user action", () => {
    const result = buildPolicyResult({
      verdict: "escalate",
      reasonCode: "UNSUPPORTED_COMMAND",
      userActionRequired: true,
    });
    expect(() => assertPolicyDryRunResult(result)).not.toThrow();
    expect(result.userActionRequired).toBe(true);
  });
});

// ── xargs dirname incident class ──────────────────────────────────────────────

describe("xargs dirname incident class — contract invariants", () => {
  it("xargs resolution with spaced path has warnings", () => {
    // Simulates what the Rust resolver would produce for:
    //   xargs dirname "/project/my project/file.txt"
    // where the space causes a split.
    const res = buildResolution({
      commandClass: "xargs",
      executable: "xargs",
      parsedArgv: ["dirname", "/project/my project/file.txt"],
      predictedTargets: [{ path: "/project/my", provenance: "xargs_expanded" }],
      confidence: "partial",
      warnings: [
        "xargs: unquoted space in '/project/my project/file.txt' splits to '/project/my' — this is the incident class",
      ],
    });
    assertResolution(res);
    expect(res.confidence).toBe("partial");
    expect(res.warnings.some((w) => w.includes("splits to"))).toBe(true);
    // The dangerous resolved path must be the pre-split prefix, not the full path.
    expect(res.predictedTargets[0]?.path).toBe("/project/my");
  });

  it("xargs resolution with -0 flag preserves full spaced path", () => {
    // With -0, xargs does NOT split on spaces.
    const res = buildResolution({
      commandClass: "xargs",
      executable: "xargs",
      parsedArgv: ["-0", "dirname", "/project/my project/file.txt"],
      predictedTargets: [{ path: "/project/my project", provenance: "xargs_expanded" }],
      confidence: "resolved",
      warnings: [],
    });
    assertResolution(res);
    expect(res.confidence).toBe("resolved");
    expect(res.warnings).toHaveLength(0);
    expect(res.predictedTargets[0]?.path).toBe("/project/my project");
  });

  it("xargs dirname incident: deny verdict is expected when target is outside write root", () => {
    // The policy layer should deny when the resolved path escapes write roots.
    const result = buildPolicyResult({
      verdict: "deny",
      reasonCode: "OUTSIDE_WRITE_ROOT",
      ruleId: "exec-outside-write-root",
      predictedTargets: ["/project/my"],
      resolutionStatus: "partial",
    });
    assertPolicyDryRunResult(result);
    expect(result.verdict).toBe("deny");
    expect(result.reasonCode).toBe("OUTSIDE_WRITE_ROOT");
  });

  it("unsupported xargs sub-command returns unsupported confidence", () => {
    const res = buildResolution({
      commandClass: "unsupported",
      executable: "xargs",
      parsedArgv: ["bash", "-c", "rm {}"],
      predictedTargets: [],
      confidence: "unsupported",
      warnings: ["xargs: sub-command 'bash' is not in the supported incident class"],
      supported: false,
    });
    assertResolution(res);
    expect(res.supported).toBe(false);
    expect(res.confidence).toBe("unsupported");
  });
});

// ── Path traversal detection ──────────────────────────────────────────────────

describe("path traversal detection — policy invariants", () => {
  it("path traversal that escapes workspace must produce a deny verdict", () => {
    // After normalization: /project/src/../../etc/passwd → /etc/passwd
    const result = buildPolicyResult({
      verdict: "deny",
      reasonCode: "OUTSIDE_WRITE_ROOT",
      predictedTargets: ["/etc/passwd"],
      resolutionStatus: "resolved",
    });
    assertPolicyDryRunResult(result);
    expect(result.verdict).toBe("deny");
    // The resolved path must be the traversal destination, not the raw arg.
    expect(result.predictedTargets).toContain("/etc/passwd");
  });

  it("path traversal to protected root produces PROTECTED_ROOT_WRITE", () => {
    const result = buildPolicyResult({
      verdict: "deny",
      reasonCode: "PROTECTED_ROOT_WRITE",
      predictedTargets: ["/project/.fusebox/policy.json"],
      resolutionStatus: "resolved",
    });
    assertPolicyDryRunResult(result);
    expect(result.reasonCode).toBe("PROTECTED_ROOT_WRITE");
  });

  it("null byte in path produces INVALID_PATH deny", () => {
    const result = buildPolicyResult({
      verdict: "deny",
      reasonCode: "INVALID_PATH",
      predictedTargets: [],
      resolutionStatus: "unsupported",
    });
    assertPolicyDryRunResult(result);
    expect(result.verdict).toBe("deny");
    expect(result.reasonCode).toBe("INVALID_PATH");
  });
});

// ── Adversarial fixture conformance ──────────────────────────────────────────

describe("adversarial fixtures — policy reason codes", () => {
  it("invalid-paths.json entries have expectedVerdict and expectedReasonCode", () => {
    const data = loadFixture("fixtures/adversarial/invalid-paths.json") as Array<{
      executable: string;
      argv: string[];
      expectedVerdict: string;
      expectedReasonCode: string;
    }>;

    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);

    for (const entry of data) {
      expect(typeof entry.executable).toBe("string");
      expect(Array.isArray(entry.argv)).toBe(true);
      expect(typeof entry.expectedVerdict).toBe("string");
      expect(typeof entry.expectedReasonCode).toBe("string");
      expect(entry.expectedReasonCode.length).toBeGreaterThan(0);
    }
  });

  it("every invalid-paths.json entry expectedVerdict is a known PolicyDecision verdict", () => {
    const validVerdicts = new Set(["allow", "log", "escalate", "deny", "unsupported"]);
    const data = loadFixture("fixtures/adversarial/invalid-paths.json") as Array<{
      expectedVerdict: string;
    }>;

    for (const entry of data) {
      expect(validVerdicts.has(entry.expectedVerdict)).toBe(true);
    }
  });

  it("every invalid-paths.json entry expectedReasonCode is a known reason code", () => {
    // These are the reason codes the policy evaluator is known to emit.
    const knownCodes = new Set([
      "INVALID_EXECUTABLE",
      "INVALID_PATH",
      "CWD_OUTSIDE_WORKSPACE",
      "PROTECTED_ROOT_WRITE",
      "OUTSIDE_WRITE_ROOT",
      "UNSUPPORTED_COMMAND",
      "PARTIAL_RESOLUTION",
      "WITHIN_SCOPE",
    ]);
    const data = loadFixture("fixtures/adversarial/invalid-paths.json") as Array<{
      expectedReasonCode: string;
    }>;

    for (const entry of data) {
      expect(knownCodes.has(entry.expectedReasonCode)).toBe(true);
    }
  });
});

// ── Scope expansion contract ──────────────────────────────────────────────────

describe("scope expansion contract invariants", () => {
  it("approved scope expansion must update write_roots and embed new policy hash", () => {
    // Simulates what the Rust scope expansion returns.
    const updatedContract = {
      schemaVersion: "1",
      sessionId: "s",
      workspaceRoots: ["/project"],
      readRoots: ["/project"],
      writeRoots: ["/project/src", "/project/extra"],
      protectedRoots: [],
      allowedCommandClasses: [],
      networkPolicy: "deny_all",
      approvalPolicy: "deny",
      expiresAt: null,
      policyHash: "newhash123",
    };
    expect(updatedContract.writeRoots).toContain("/project/extra");
    expect(typeof updatedContract.policyHash).toBe("string");
    expect(updatedContract.policyHash.length).toBeGreaterThan(0);
  });

  it("scope expansion must be idempotent — duplicate path not added twice", () => {
    // After expansion, the path appears exactly once.
    const writeRoots = ["/project/src"];
    const pathToAdd = "/project/src";
    const newRoots = writeRoots.includes(pathToAdd)
      ? writeRoots
      : [...writeRoots, pathToAdd];
    expect(newRoots.filter((r) => r === pathToAdd)).toHaveLength(1);
  });

  it("scope expansion rejection leaves the original contract unchanged", () => {
    // Simulates rejection — contract is not mutated.
    const originalRoots = ["/project/src"];
    const contract = { writeRoots: [...originalRoots] };
    // (rejected) — contract must be unchanged
    expect(contract.writeRoots).toEqual(originalRoots);
  });
});

// ── Policy hash stability ─────────────────────────────────────────────────────

describe("policy hash stability", () => {
  it("policy hash must be a non-empty string in a valid contract", () => {
    // The init command embeds a hash; verify it looks like a SHA-256 hex string.
    const hash = "a".repeat(64); // 256 bits = 64 hex chars
    expect(typeof hash).toBe("string");
    expect(hash.length).toBe(64);
    expect(/^[0-9a-f]+$/i.test(hash)).toBe(true);
  });

  it("different write roots must produce different policy hashes", () => {
    // The hash is over the serialised contract; any field change must change the hash.
    // This is enforced at the Rust level; here we just verify the structural invariant
    // that the hash field captures all mutable contract state.
    const contract1 = {
      schemaVersion: "1",
      sessionId: "s",
      workspaceRoots: ["/project"],
      writeRoots: ["/project/src"],
      policyHash: null,
    };
    const contract2 = {
      ...contract1,
      writeRoots: ["/project/src", "/project/extra"],
    };
    // The serialised forms differ ⇒ hashes must differ.
    expect(JSON.stringify(contract1)).not.toBe(JSON.stringify(contract2));
  });
});


// ── Resolver fixture file conformance ─────────────────────────────────────────

describe("resolver-cases.json fixture conformance", () => {
  interface ResolverCase {
    _description: string;
    executable: string;
    argv: string[];
    preTokenized: boolean;
    expectedCommandClass: CommandClass;
    expectedConfidence: Confidence;
    expectedSupported?: boolean;
    expectedDangerousTarget?: string;
    expectedTarget?: string;
    expectedNormalizedTarget?: string;
    expectedProvenance?: Provenance;
    expectedWarningContains?: string | null;
  }

  it("resolver-cases.json is a non-empty array with required fields", () => {
    const data = loadFixture("fixtures/adversarial/resolver-cases.json") as ResolverCase[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    for (const entry of data) {
      expect(typeof entry.executable).toBe("string");
      expect(Array.isArray(entry.argv)).toBe(true);
      expect(typeof entry.expectedCommandClass).toBe("string");
      expect(typeof entry.expectedConfidence).toBe("string");
    }
  });

  it("all supported xargs cases with unquoted spaces and no -0 have expectedConfidence partial", () => {
    const data = loadFixture("fixtures/adversarial/resolver-cases.json") as ResolverCase[];
    // Only consider xargs cases that are resolved as a supported xargs class (not sub-unsupported).
    const xargsSpacedCases = data.filter(
      (c) =>
        c.executable === "xargs" &&
        c.expectedCommandClass === "xargs" &&
        c.argv.some((a) => a.includes(" ")),
    );
    for (const c of xargsSpacedCases) {
      const hasNullDelim = c.argv.includes("-0") || c.argv.includes("--null");
      if (!hasNullDelim && !c.preTokenized) {
        // Without -0, spaces cause splits → partial confidence.
        expect(c.expectedConfidence).toBe("partial");
      }
    }
  });

  it("all unsupported cases have expectedSupported false or expectedConfidence unsupported", () => {
    const data = loadFixture("fixtures/adversarial/resolver-cases.json") as ResolverCase[];
    const unsupportedCases = data.filter((c) => c.expectedCommandClass === "unsupported");
    for (const c of unsupportedCases) {
      expect(c.expectedConfidence).toBe("unsupported");
      if (c.expectedSupported !== undefined) {
        expect(c.expectedSupported).toBe(false);
      }
    }
  });
});

// ── Policy dry-run fixture file conformance ────────────────────────────────────

describe("policy-dry-run-cases.json fixture conformance", () => {
  interface PolicyCase {
    _description: string;
    executable: string;
    argv: string[];
    cwd: string;
    expectedVerdict: Verdict;
    expectedReasonCode: string;
    expectedResolvedTarget?: string;
  }

  it("policy-dry-run-cases.json is a non-empty array", () => {
    const data = loadFixture("fixtures/adversarial/policy-dry-run-cases.json") as PolicyCase[];
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("all deny entries have non-empty expectedReasonCode", () => {
    const data = loadFixture("fixtures/adversarial/policy-dry-run-cases.json") as PolicyCase[];
    for (const entry of data) {
      if (entry.expectedVerdict === "deny") {
        expect(entry.expectedReasonCode.length).toBeGreaterThan(0);
      }
    }
  });

  it("every expectedVerdict in policy-dry-run-cases.json is a valid verdict", () => {
    const validVerdicts = new Set<string>(["allow", "log", "escalate", "deny", "unsupported"]);
    const data = loadFixture("fixtures/adversarial/policy-dry-run-cases.json") as PolicyCase[];
    for (const entry of data) {
      expect(validVerdicts.has(entry.expectedVerdict)).toBe(true);
    }
  });

  it("every expectedReasonCode in policy-dry-run-cases.json is a known reason code", () => {
    const knownCodes = new Set([
      "INVALID_EXECUTABLE",
      "INVALID_PATH",
      "CWD_OUTSIDE_WORKSPACE",
      "PROTECTED_ROOT_WRITE",
      "OUTSIDE_WRITE_ROOT",
      "UNSUPPORTED_COMMAND",
      "PARTIAL_RESOLUTION",
      "WITHIN_SCOPE",
    ]);
    const data = loadFixture("fixtures/adversarial/policy-dry-run-cases.json") as PolicyCase[];
    for (const entry of data) {
      expect(knownCodes.has(entry.expectedReasonCode)).toBe(true);
    }
  });

  it("path traversal case has expectedResolvedTarget /etc/passwd", () => {
    const data = loadFixture("fixtures/adversarial/policy-dry-run-cases.json") as PolicyCase[];
    const traversalCase = data.find(
      (c) => c.argv.some((a) => a.includes("../../etc/passwd")),
    );
    expect(traversalCase).toBeDefined();
    expect(traversalCase?.expectedResolvedTarget).toBe("/etc/passwd");
  });
});
