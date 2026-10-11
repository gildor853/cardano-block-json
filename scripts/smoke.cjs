// Runtime smoke test of the built package (CommonJS entry). No dependencies, no network.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { decodeBlock, toJson, CardanoBlockError, parsePoint, NETWORK_MAGIC } = require("cardano-block-json");

const block = decodeBlock(new Uint8Array(readFileSync(join(__dirname, "..", "test", "fixtures", "babbage-mainnet.cbor"))));
assert.equal(block.era, "babbage");
assert.equal(block.integrity.bodyHashValid, true);
assert.ok(JSON.stringify(toJson(block)).length > 1000);
assert.equal(NETWORK_MAGIC.mainnet, 764824073);
assert.equal(parsePoint(`5.${"ab".repeat(32)}`).slot, 5n);
assert.throws(() => decodeBlock("zz"), CardanoBlockError);

console.log(`CJS smoke test passed on Node ${process.version}`);
