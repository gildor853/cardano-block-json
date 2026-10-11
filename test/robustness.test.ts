// Mutation fuzzing: corrupted or truncated input must only ever produce a CardanoBlockError
// (or decode successfully) — never a TypeError, RangeError or a hang.
import { describe, expect, it } from "vitest";
import { decodeBlock, isCardanoBlockError, toJson } from "../src/index.js";
import { decodeCbor } from "../src/cbor.js";
import { fixture } from "./helpers/fixtures.js";

const NAMES = ["byron-mainnet", "byron-ebb-preprod", "shelley-mainnet-update", "mary-mainnet-mint", "alonzo-mainnet", "conway-preprod-votes", "conway-mainnet-paramchange"];

// Deterministic PRNG (mulberry32) so failures are reproducible.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function attempt(input: Uint8Array, label: string): void {
  try {
    const block = decodeBlock(input);
    JSON.stringify(toJson(block));
  } catch (err) {
    if (!isCardanoBlockError(err)) throw new Error(`${label}: unexpected ${(err as Error)?.stack ?? String(err)}`);
  }
}

describe("robustness", () => {
  for (const name of NAMES) {
    it(`survives truncation and byte mutations of ${name}`, () => {
      const data = fixture(name);
      const rand = rng(name.length * 7919);
      const cuts = new Set<number>([0, 1, 2, 3, data.length - 1]);
      for (let i = 0; i < 60; i++) cuts.add(Math.floor(rand() * data.length));
      for (const cut of cuts) attempt(data.subarray(0, cut), `${name} truncated at ${cut}`);
      for (let i = 0; i < 300; i++) {
        const copy = data.slice();
        const flips = 1 + Math.floor(rand() * 4);
        for (let j = 0; j < flips; j++) copy[Math.floor(rand() * copy.length)] = Math.floor(rand() * 256);
        attempt(copy, `${name} mutation ${i}`);
      }
    }, 60_000);
  }

  it("rejects trailing data and hostile CBOR headers", () => {
    const votes = fixture("conway-preprod-votes");
    expect(() => decodeBlock(Uint8Array.of(...votes, 0))).toThrow(/trailing/i);
    for (const hostile of [
      Uint8Array.of(0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), // array of 2^64-1 items
      Uint8Array.of(0x5b, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00), // 4 GiB byte string
      Uint8Array.of(0xbb, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), // huge map
      new Uint8Array(100_000).fill(0x81), // deep nesting
      new Uint8Array(100_000).fill(0x9f), // deep indefinite nesting
      Uint8Array.of(0x1c), // reserved additional info
      Uint8Array.of(0xff), // stray break
    ]) {
      try {
        decodeBlock(hostile);
        throw new Error("expected failure");
      } catch (err) {
        expect(isCardanoBlockError(err)).toBe(true);
      }
      try {
        decodeCbor(hostile);
      } catch (err) {
        expect(isCardanoBlockError(err)).toBe(true);
      }
    }
  });
});
