// Tests for runtime inference engine (opt-in)
import { describe, it, expect } from "vitest";
import { inferRuntimeBehavior, renderInferenceMarkdown } from "../src/engine/runtimeInference.js";
import type { ParsedFile } from "../src/parsers/types.js";

function makeParsedFile(overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    path: "src/test.ts",
    lang: "ts",
    contentHash: "abc123",
    exports: [],
    imports: [],
    signatures: [],
    usedFallback: false,
    warnings: [],
    ...overrides,
  };
}

describe("inferRuntimeBehavior — safety", () => {
  it("skips and warns on eval()", () => {
    const file = makeParsedFile();
    const content = `const x = eval("2+2");`;
    const result = inferRuntimeBehavior(file, content);
    expect(result.skippedDynamic).toBe(true);
    expect(result.warnings.some(w => w.includes("DYNAMIC_CODE_SKIPPED"))).toBe(true);
    expect(result.callGraph).toHaveLength(0);
    expect(result.apiEndpoints).toHaveLength(0);
  });

  it("skips and warns on new Function()", () => {
    const file = makeParsedFile();
    const content = `const fn = new Function("return 1");`;
    const result = inferRuntimeBehavior(file, content);
    expect(result.skippedDynamic).toBe(true);
    expect(result.warnings.some(w => w.includes("DYNAMIC_CODE_SKIPPED"))).toBe(true);
  });

  it("skips and warns on dynamic import()", () => {
    const file = makeParsedFile();
    const content = `const m = await import("some-module");`;
    const result = inferRuntimeBehavior(file, content);
    expect(result.skippedDynamic).toBe(true);
  });

  it("does not skip clean files", () => {
    const file = makeParsedFile({
      exports: [{ name: "greet", kind: "function", line: 1, column: 0 }],
    });
    const content = `export function greet(name: string) { return "Hello " + name; }`;
    const result = inferRuntimeBehavior(file, content);
    expect(result.skippedDynamic).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it("does not flag dynamic warnings for eval/import text in comments or strings", () => {
    const file = makeParsedFile();
    const content = [
      "// eval('not-real') in a comment",
      "const note = \"new Function('also-not-real')\";",
      "const sample = 'import(\"fake\") just text';",
      "export function ok() { return 1; }",
    ].join("\n");
    const result = inferRuntimeBehavior(file, content);
    expect(result.skippedDynamic).toBe(false);
    expect(result.warnings.some((w) => w.includes("DYNAMIC_CODE_SKIPPED"))).toBe(false);
  });
});

describe("inferRuntimeBehavior — API endpoint extraction", () => {
  it("extracts Express GET route", () => {
    const file = makeParsedFile({ path: "src/routes.ts" });
    const content = `app.get('/users', getUsers);`;
    const result = inferRuntimeBehavior(file, content);
    expect(result.apiEndpoints.length).toBeGreaterThan(0);
    const ep = result.apiEndpoints[0]!;
    expect(ep.method).toBe("GET");
    expect(ep.route).toBe("/users");
  });

  it("extracts Express POST route", () => {
    const file = makeParsedFile({ path: "src/routes.ts" });
    const content = `router.post('/auth/login', loginHandler);`;
    const result = inferRuntimeBehavior(file, content);
    expect(result.apiEndpoints.some(ep => ep.method === "POST" && ep.route === "/auth/login")).toBe(true);
  });

  it("extracts NestJS decorator route", () => {
    const file = makeParsedFile({ path: "src/controller.ts" });
    const content = `@Get('/items')\ngetItems() {}`;
    const result = inferRuntimeBehavior(file, content);
    expect(result.apiEndpoints.some(ep => ep.method === "GET" && ep.route === "/items")).toBe(true);
  });

  it("does not hallucinate routes from non-route code", () => {
    const file = makeParsedFile({ path: "src/utils.ts" });
    const content = `const x = arr.map(item => item.value);`;
    const result = inferRuntimeBehavior(file, content);
    expect(result.apiEndpoints).toHaveLength(0);
  });
});

describe("inferRuntimeBehavior — call graph", () => {
  it("uses AST call graph path for valid TypeScript", () => {
    const file = makeParsedFile({
      exports: [{ name: "ping", kind: "function", line: 1, column: 0 }],
      signatures: [{ name: "ping", signature: "function ping()", line: 1, column: 0, async: false, generator: false, params: [] }],
    });
    const content = "export function ping() { return 1; }\n";
    const result = inferRuntimeBehavior(file, content);
    expect(result.warnings.some((w) => w.includes("INFERENCE_AST_FALLBACK_REGEX"))).toBe(false);
  });

  it("falls back to regex when AST parse fails and records parse reason", () => {
    const file = makeParsedFile({
      exports: [{ name: "broken", kind: "function", line: 1, column: 0 }],
    });
    const content = "export function broken( { return 1; }\n";
    const result = inferRuntimeBehavior(file, content);
    expect(result.warnings.some((w) => w.includes("INFERENCE_AST_FALLBACK_REGEX"))).toBe(true);
    expect(result.warnings.some((w) => w.toLowerCase().includes("parse") || w.includes("Unexpected"))).toBe(true);
  });

  it("builds call graph between known exports", () => {
    const file = makeParsedFile({
      exports: [
        { name: "processUser", kind: "function", line: 1, column: 0 },
        { name: "validateUser", kind: "function", line: 5, column: 0 },
      ],
      signatures: [
        { name: "processUser", signature: "function processUser(u)", line: 1, column: 0, async: false, generator: false, params: ["u"] },
      ],
    });
    const content = [
      "export function processUser(u) {",
      "  validateUser(u);",
      "}",
      "",
      "export function validateUser(u) { return !!u; }",
    ].join("\n");
    const result = inferRuntimeBehavior(file, content);
    const edge = result.callGraph.find(e => e.callee === "validateUser");
    expect(edge).toBeDefined();
    expect(edge?.caller).toBe("processUser");
  });
});

describe("inferRuntimeBehavior — data flow", () => {
  it("tracks req → transformed → result", () => {
    const file = makeParsedFile({
      signatures: [{
        name: "handleLogin",
        signature: "async function handleLogin(req, res)",
        line: 1,
        column: 0,
        async: true,
        generator: false,
        params: ["req", "res"],
      }],
    });
    const content = [
      "async function handleLogin(req, res) {",
      "  const body = sanitize(req.body);",
      "  const token = createToken(body);",
      "}",
    ].join("\n");
    const result = inferRuntimeBehavior(file, content);
    expect(result.dataFlows.length).toBeGreaterThan(0);
    const flow = result.dataFlows.find(f => f.source === "req");
    expect(flow).toBeDefined();
  });
});

describe("renderInferenceMarkdown", () => {
  it("includes section header", () => {
    const md = renderInferenceMarkdown([]);
    expect(md).toContain("Runtime Behavior Inference");
  });

  it("labels skipped files", () => {
    const file = makeParsedFile({ path: "src/bad.ts" });
    const content = `eval("x")`;
    const result = inferRuntimeBehavior(file, content);
    const md = renderInferenceMarkdown([result]);
    expect(md).toContain("SKIPPED");
  });

  it("includes API endpoints in output", () => {
    const file = makeParsedFile({ path: "src/routes.ts" });
    const content = `app.get('/ping', pingHandler);`;
    const result = inferRuntimeBehavior(file, content);
    const md = renderInferenceMarkdown([result]);
    expect(result.apiEndpoints.length).toBeGreaterThan(0);
    expect(md).toContain("GET /ping");
  });
});
