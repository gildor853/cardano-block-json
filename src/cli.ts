#!/usr/bin/env node
// Executable entry point; see cli-main.ts.
import { readFileSync } from "node:fs";
import { runCli } from "./cli-main.js";

runCli(process.argv.slice(2), {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  readFile: (p) => new Uint8Array(readFileSync(p === "-" ? 0 : p)),
}).then((code) => {
  process.exitCode = code;
});
