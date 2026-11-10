import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  clean: true,
  format: ["esm"],
  dts: true,
  sourcemap: true,
  target: "node22",
  external: ["node:sqlite"],
  shims: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
