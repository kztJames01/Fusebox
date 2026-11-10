// Determinism tests: same inputs must produce byte-identical outputs
import { describe, it, expect } from "vitest";

// Tests determinism at the inference and conflict-detection level
// (CLI e2e determinism is in the CI workflow script)

import {
  inferRuntimeBehavior,
  renderInferenceMarkdown,
} from "../src/engine/runtimeInference.js";
import {
  detectConflicts,
  renderConflictMarkdown,
} from "../src/ui/agent-ui/conflicts.js";
import type { ParsedFile } from "../src/parsers/types.js";

function makeParsedFile(p: string, overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path: p,
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

const SAMPLE_CONTENT = `
export function greet(name: string) { return "Hi " + name; }
export function farewell(name: string) { return "Bye " + name; }
app.get('/hello', greet);
app.post('/bye', farewell);
`;

const SAMPLE_FILE = makeParsedFile("src/greet.ts", {
  exports: [
    { name: "greet", kind: "function", line: 2, column: 0 },
    { name: "farewell", kind: "function", line: 3, column: 0 },
  ],
  signatures: [
    { name: "greet", signature: "function greet(name: string)", line: 2, column: 0, async: false, generator: false, params: ["name"] },
    { name: "farewell", signature: "function farewell(name: string)", line: 3, column: 0, async: false, generator: false, params: ["name"] },
  ],
});

describe("runtime inference determinism", () => {
  it("produces identical results for two calls on same input", () => {
    const r1 = inferRuntimeBehavior(SAMPLE_FILE, SAMPLE_CONTENT);
    const r2 = inferRuntimeBehavior(SAMPLE_FILE, SAMPLE_CONTENT);

    // Compare structural fields deterministically (exclude non-deterministic fields if any)
    expect(r1.skippedDynamic).toBe(r2.skippedDynamic);
    expect(r1.callGraph).toEqual(r2.callGraph);
    expect(r1.apiEndpoints).toEqual(r2.apiEndpoints);
    expect(r1.dataFlows.length).toBe(r2.dataFlows.length);
    expect(r1.warnings).toEqual(r2.warnings);
  });

  it("produces identical markdown for two renders", () => {
    const r1 = inferRuntimeBehavior(SAMPLE_FILE, SAMPLE_CONTENT);
    const r2 = inferRuntimeBehavior(SAMPLE_FILE, SAMPLE_CONTENT);
    const md1 = renderInferenceMarkdown([r1]);
    const md2 = renderInferenceMarkdown([r2]);
    expect(md1).toBe(md2);
  });
});

describe("conflict detection determinism", () => {
  const agentA = makeParsedFile("src/auth.ts", {
    exports: [{ name: "login", kind: "function", line: 5, column: 0 }],
    signatures: [{ name: "login", signature: "function login(u, p)", line: 5, column: 0, async: false, generator: false, params: ["u", "p"] }],
  });
  const agentB = makeParsedFile("src/auth.ts", {
    exports: [{ name: "login", kind: "function", line: 5, column: 0 }],
    signatures: [{ name: "login", signature: "function login(credentials: Creds)", line: 5, column: 0, async: false, generator: false, params: ["credentials"] }],
  });

  it("produces identical conflict arrays on repeated calls", () => {
    const r1 = detectConflicts([agentA], [agentB]);
    const r2 = detectConflicts([agentA], [agentB]);
    // conflicts array should be equal (hash may differ due to timestamp)
    expect(JSON.stringify(r1.conflicts)).toBe(JSON.stringify(r2.conflicts));
    expect(r1.totalConflicts).toBe(r2.totalConflicts);
    expect(r1.resolutionSuggestions).toEqual(r2.resolutionSuggestions);
  });

  it("produces identical markdown on repeated renders", () => {
    const r1 = detectConflicts([agentA], [agentB]);
    const r2 = detectConflicts([agentA], [agentB]);
    // Render with same conflicts (override timestamp to be equal for comparison)
    const mocked1 = { ...r1, scannedAt: "2026-01-01T00:00:00.000Z" };
    const mocked2 = { ...r2, scannedAt: "2026-01-01T00:00:00.000Z" };
    expect(renderConflictMarkdown(mocked1)).toBe(renderConflictMarkdown(mocked2));
  });
});

describe("inference timeout guard", () => {
  it("keeps call graph deterministic even when timeout warnings differ in count", () => {
    const content = Array.from({ length: 5000 }, (_, i) => `const x${i} = greet(x${Math.max(0, i - 1)});`).join("\n");
    const file = makeParsedFile("src/medium.ts", {
      exports: [{ name: "greet", kind: "function", line: 1, column: 0 }],
      signatures: [{ name: "greet", signature: "function greet(x)", line: 1, column: 0, async: false, generator: false, params: ["x"] }],
    });
    const r1 = inferRuntimeBehavior(file, content, { timeoutMs: 5 });
    const r2 = inferRuntimeBehavior(file, content, { timeoutMs: 5 });
    expect(r1.callGraph).toEqual(r2.callGraph);
    expect(r1.apiEndpoints).toEqual(r2.apiEndpoints);
  });

  it("emits timeout warning for very tight timeout budget", () => {
    // Generate a large file content with lots of lines
    const bigContent = Array.from({ length: 100000 }, (_, i) => `const x${i} = greet(x${i - 1});`).join("\n");
    const file = makeParsedFile("src/big.ts");
    const start = Date.now();
    const result = inferRuntimeBehavior(file, bigContent, { timeoutMs: 1 });
    const elapsed = Date.now() - start;
    // The guard itself is asserted by the timeout warning below. Keep this
    // bound generous so parallel CI workers cannot turn it into a flake.
    expect(elapsed).toBeLessThan(3000);
    expect(result.warnings.some((w) => w.includes("INFERENCE_TIMEOUT"))).toBe(true);
  });
});
