import { describe, expect, it } from "vitest";

import { scoreExport } from "../src/engine/significance.js";

describe("significance", () => {
  it("keeps the trivial filter narrower than all", () => {
    const constant = { kind: "const" as const, name: "VERSION", line: 1 };

    expect(scoreExport(constant, "src/engine/version.ts", { filter: "trivial" })).toBe("low");
    expect(scoreExport(constant, "src/engine/version.ts", { filter: "all" })).toBe("high");
  });

  it("honors trackTypes even when the filter is all", () => {
    const type = { kind: "type" as const, name: "Options", line: 1 };

    expect(scoreExport(type, "src/options.ts", { filter: "all", trackTypes: false })).toBe("low");
    expect(scoreExport(type, "src/options.ts", { filter: "all", trackTypes: true })).toBe("high");
  });

  it("uses configured core paths for logic-level constants", () => {
    const constant = { kind: "const" as const, name: "VERSION", line: 1 };

    expect(scoreExport(constant, "lib/runtime/version.ts", {
      filter: "logic",
      corePaths: ["lib/runtime/"],
    })).toBe("medium");
  });
});
