// Live tests against real relays. Skipped unless CARDANO_LIVE=1, so the regular test run
// never touches the network:
//   CARDANO_LIVE=1 npx vitest run test/live.test.ts
// Relays can be overridden with CARDANO_RELAY_MAINNET / _PREPROD / _PREVIEW (host:port).
// Each test fetches a block stored in test/fixtures and compares it byte for byte.
import { describe, expect, it } from "vitest";
import { blockPoint, decodeBlock, fetchRawBlock, isShelleyBlock, type NetworkName } from "../src/index.js";
import { toHex } from "../src/bytes.js";
import { fixture } from "./helpers/fixtures.js";

const LIVE = process.env.CARDANO_LIVE === "1";

const CASES: Array<{ network: NetworkName; relay: string; fixture: string }> = [
  { network: "mainnet", relay: process.env.CARDANO_RELAY_MAINNET ?? "backbone.cardano.iog.io:3001", fixture: "conway-mainnet-hardfork" },
  { network: "preprod", relay: process.env.CARDANO_RELAY_PREPROD ?? "preprod-node.play.dev.cardano.org:3001", fixture: "conway-preprod-votes" },
  { network: "preview", relay: process.env.CARDANO_RELAY_PREVIEW ?? "preview-node.play.dev.cardano.org:3001", fixture: "conway-preview-empty" },
];

describe.skipIf(!LIVE)("live relays", () => {
  for (const c of CASES) {
    it(`fetches a known ${c.network} block from ${c.relay}`, async () => {
      const expected = fixture(c.fixture);
      const { slot, hash } = blockPoint(expected);
      const raw = await fetchRawBlock({ relay: c.relay, point: { slot, hash }, network: c.network, timeoutMs: 60_000 });
      expect(toHex(raw.cbor)).toBe(toHex(expected));
      const block = decodeBlock(raw.cbor);
      expect(block.hash).toBe(hash);
      expect(isShelleyBlock(block) && block.integrity.bodyHashValid).toBe(true);
      console.log(`${c.network}: ${c.relay} (${raw.address}) N2N v${raw.version}, ${raw.cbor.length} bytes`);
    }, 90_000);
  }
});
