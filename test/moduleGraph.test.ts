import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildDependencyCounts,
  buildModuleEdges,
  buildModuleGraph,
  DEPENDENCY_GRAPH_FILE,
  renderDependencyMarkdown,
  renderMermaidGraph,
  writeDependencyGraph,
} from "../src/engine/moduleResolution.js";
import type { AstExtract } from "../src/types/scan.js";

function extract(file: string, imports: string[]): AstExtract {
  return {
    file,
    exports: [{ name: "main", kind: "function", line: 1, column: 0 }],
    imports,
    signatures: [`function main()`],
  };
}

const extracts: AstExtract[] = [
  extract("src/a.ts", ["./b"]),
  extract("src/b.ts", ["./c"]),
  extract("src/c.ts", []),
  extract("src/tests/a.test.ts", ["../a"]),
];

describe("module dependency graph", () => {
  it("resolves only relative imports and counts dependents", () => {
    const edges = buildModuleEdges(extracts);
    expect(edges).toEqual([
      { from: "src/a.ts", to: "src/b.ts" },
      { from: "src/b.ts", to: "src/c.ts" },
      { from: "src/tests/a.test.ts", to: "src/a.ts" },
    ]);

    const counts = buildDependencyCounts(extracts);
    expect(counts.get("src/a.ts")).toBe(1);
    expect(counts.get("src/b.ts")).toBe(1);
    expect(counts.get("src/c.ts")).toBe(1);
  });

  it("renders deterministic Mermaid output", () => {
    const first = renderMermaidGraph(buildModuleGraph(extracts));
    const second = renderMermaidGraph(buildModuleGraph([...extracts].reverse()));

    expect(first).toBe(second);
    expect(first.startsWith("flowchart LR")).toBe(true);
    expect(first).toContain("n0[\"src/a.ts\"]");
    expect(first).toContain("n0 --> n1");
  });

  it("limits the graph to N import hops from entry files", () => {
    const graph = buildModuleGraph(extracts, { maxDepth: 1 });
    expect(graph.nodes).toEqual(["src/a.ts", "src/tests/a.test.ts"]);
    expect(graph.edges).toEqual([
      { from: "src/tests/a.test.ts", to: "src/a.ts" },
    ]);
    expect(graph.maxDepth).toBe(1);

    const deeper = buildModuleGraph(extracts, { maxDepth: 2 });
    expect(deeper.nodes).toEqual(["src/a.ts", "src/b.ts", "src/tests/a.test.ts"]);
    expect(deeper.edges).toEqual([
      { from: "src/a.ts", to: "src/b.ts" },
      { from: "src/tests/a.test.ts", to: "src/a.ts" },
    ]);
  });

  it("writes MEMO_LOG_DEPS.md atomically with a Mermaid block", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memolog-deps-"));
    const result = writeDependencyGraph(root, extracts, { maxDepth: 2 });

    const content = await fs.readFile(path.join(root, DEPENDENCY_GRAPH_FILE), "utf8");
    expect(result.path).toBe(path.join(root, DEPENDENCY_GRAPH_FILE));
    expect(content).toContain("# Module Dependency Graph");
    expect(content).toContain("```mermaid");
    expect(content).toContain("flowchart LR");
    expect(content).toContain("- **Depth limit:** 2");
    expect(content).toBe(renderDependencyMarkdown(result.graph, { maxDepth: 2 }) + "\n");
  });

  it("keeps cycles stable by selecting a deterministic root", () => {
    const cyclic = [extract("src/x.ts", ["./y"]), extract("src/y.ts", ["./x"])];
    const graph = buildModuleGraph(cyclic, { maxDepth: 0 });
    expect(graph.nodes).toEqual(["src/x.ts"]);
    expect(graph.edges).toEqual([]);
  });

  it("resolves NodeNext .js/.jsx imports to .ts/.tsx files when no .js file exists", () => {
    const esmExtracts: AstExtract[] = [
      extract("src/app.ts", ["./utils.js", "./view.jsx", "./legacy.js"]),
      extract("src/utils.ts", []),
      extract("src/view.tsx", []),
      extract("src/legacy.js", []),
      extract("src/legacy.ts", []),
    ];

    const edges = buildModuleEdges(esmExtracts);
    expect(edges).toEqual([
      { from: "src/app.ts", to: "src/legacy.js" },
      { from: "src/app.ts", to: "src/utils.ts" },
      { from: "src/app.ts", to: "src/view.tsx" },
    ]);
  });
});
