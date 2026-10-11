// Runtime smoke test of the built package (ESM entry + CLI), run by CI on Node
// versions the test runner no longer supports. No dependencies, no network.
// The bare specifier resolves to ./dist through the package's "exports" map.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { blockPoint, decodeBlock, fetchBlock, isCardanoBlockError, stringifyBlock, toJson } from "cardano-block-json";

const fixture = (name) => new Uint8Array(readFileSync(new URL(`../test/fixtures/${name}.cbor`, import.meta.url)));

// Real mainnet blocks (Conway hard-fork initiation and a Byron main block).
const conway = decodeBlock(fixture("conway-mainnet-hardfork"));
assert.equal(conway.era, "conway");
assert.equal(conway.slot, 143212791n);
assert.equal(conway.hash, "ac8038e5538582f8721a49858ded4f12ae8987b3aca1eab9beed65c9f64e50a1");
assert.equal(conway.integrity.bodyHashValid, true);
assert.equal(blockPoint(fixture("conway-mainnet-hardfork")).slot, 143212791n);
assert.equal(typeof toJson(conway).slot, "string");
assert.equal(decodeBlock(fixture("byron-mainnet")).era, "byron");
assert.ok(stringifyBlock(conway).includes('"era": "conway"'));

// A hash alone is rejected before any connection is made.
await assert.rejects(
  fetchBlock({ relay: "127.0.0.1:1", point: conway.hash, allowPrivateAddresses: true }),
  (err) => isCardanoBlockError(err, "INVALID_ARGUMENT") && /slot/.test(err.message),
);
// A relay that accepts and immediately closes yields a CONNECTION/PROTOCOL error, not a crash.
const server = createServer((s) => s.destroy());
await new Promise((r) => server.listen(0, "127.0.0.1", r));
await assert.rejects(
  fetchBlock({ relay: `127.0.0.1:${server.address().port}`, point: { slot: conway.slot, hash: conway.hash }, allowPrivateAddresses: true, timeoutMs: 5000 }),
  (err) => isCardanoBlockError(err) && ["CONNECTION", "PROTOCOL"].includes(err.code),
);
server.close();

// CLI: decode a local file.
const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const out = JSON.parse(execFileSync(process.execPath, [cli, "--file", new URL("../test/fixtures/mary-mainnet-mint.cbor", import.meta.url).pathname], { encoding: "utf8" }));
assert.equal(out.era, "mary");
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
assert.equal(execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim(), version);

console.log(`ESM smoke test passed on Node ${process.version}`);
