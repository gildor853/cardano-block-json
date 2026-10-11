import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "es2020",
    platform: "node",
    treeshake: true,
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: false,
    clean: false,
    target: "es2020",
    platform: "node",
    define: { __VERSION__: JSON.stringify(version) },
  },
]);
