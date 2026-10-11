import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { blake2b, blake2b224, blake2b256 } from "../src/blake2b.js";
import { bytesEqual, fromHex, toHex, utf8Encode, utf8OrUndefined } from "../src/bytes.js";
import { base58Encode, bech32Encode } from "../src/encoding.js";
import { assetFingerprint, cip129, govActionId, keyHash, poolId } from "../src/ids.js";

const enc = (s: string): Uint8Array => utf8Encode(s);

describe("blake2b", () => {
  it("matches RFC 7693 and well-known vectors", () => {
    expect(toHex(blake2b(enc("abc"), 64))).toBe(
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923",
    );
    expect(toHex(blake2b256(new Uint8Array()))).toBe("0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8");
    expect(toHex(blake2b224(new Uint8Array()))).toBe("836cc68931c2e4e3e838602eca1902591d216837bafddfe6f0c8cb07");
  });

  it("agrees with node:crypto blake2b512 for lengths 0..400", () => {
    for (let n = 0; n <= 400; n += n < 260 ? 1 : 7) {
      const data = Uint8Array.from({ length: n }, (_, i) => (i * 31 + n) & 0xff);
      expect(toHex(blake2b(data, 64))).toBe(createHash("blake2b512").update(data).digest("hex"));
    }
  });

  it("rejects invalid output lengths", () => {
    expect(() => blake2b(new Uint8Array(), 0)).toThrow(RangeError);
    expect(() => blake2b(new Uint8Array(), 65)).toThrow(RangeError);
  });
});

describe("bytes helpers", () => {
  it("round-trips hex and rejects bad hex", () => {
    expect(toHex(fromHex("00ff10Ab")!)).toBe("00ff10ab");
    expect(fromHex("abc")).toBeUndefined();
    expect(fromHex("zz")).toBeUndefined();
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2))).toBe(true);
    expect(bytesEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3))).toBe(false);
    expect(bytesEqual(Uint8Array.of(1), Uint8Array.of(1, 3))).toBe(false);
    expect(utf8OrUndefined(Uint8Array.of(0xff))).toBeUndefined();
    expect(utf8OrUndefined(enc("ok"))).toBe("ok");
  });
});

describe("encodings and identifiers", () => {
  it("bech32 (BIP-173 vector) and base58", () => {
    // BIP-173: "a" with empty data
    expect(bech32Encode("a", new Uint8Array())).toBe("a12uel5l");
    expect(base58Encode(fromHex("00010966776006953d5567439e5e39f86a0d273beed61967f6")!)).toBe("16UwLL9Risc3QfPqBUvKofHmBQ7wMtjvM");
    expect(base58Encode(new Uint8Array())).toBe("");
    expect(base58Encode(Uint8Array.of(0, 0))).toBe("11");
  });

  it("CIP-14 fingerprints", () => {
    expect(assetFingerprint("7eae28af2208be856f7a119668ae52a49b73725e326dc16579dcc373", "")).toBe(
      "asset1rjklcrnsdzqp65wjgrg55sy9723kw09mlgvlc3",
    );
    expect(assetFingerprint("1e349c9bdea19fd6c147626a5260bc44b71635f398b67c59881df209", "504154415445")).toBe(
      "asset1hv4p5tv2a837mzqrst04d0dcptdjmluqvdx9k3",
    );
  });

  it("CIP-129 governance identifiers", () => {
    const zero = "00".repeat(28);
    expect(cip129(0, { type: "key", hash: zero })).toBe("cc_hot1qgqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqvcdjk7");
    expect(cip129(1, { type: "script", hash: zero })).toBe("cc_cold1zvqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq6kflvs");
    expect(cip129(2, { type: "key", hash: zero })).toBe("drep1ygqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq7vlc9n");
    expect(govActionId("00".repeat(32), 17)).toBe("gov_action1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpzklpgpf");
    expect(govActionId("11".repeat(32), 0)).toBe("gov_action1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsq6dmejn");
  });

  it("pool ids and key hashes", () => {
    expect(poolId("2d6984805b2281950a85da5aedfa4e02f989e139cd0d669d35770be1")).toBe(
      "pool1945cfqzmy2qe2z59mfdwm7jwqtucncfee5xkd8f4wu97zr8xuys",
    );
    expect(keyHash(new Uint8Array(32))).toHaveLength(56);
  });
});

describe("isShelleyBlock", async () => {
  const { decodeBlock, isShelleyBlock } = await import("../src/index.js");
  const { fixture } = await import("./helpers/fixtures.js");
  it("narrows by era", () => {
    expect(isShelleyBlock(decodeBlock(fixture("shelley-mainnet-pool")))).toBe(true);
    expect(isShelleyBlock(decodeBlock(fixture("conway-preview-empty")))).toBe(true);
    expect(isShelleyBlock(decodeBlock(fixture("byron-mainnet")))).toBe(false);
    expect(isShelleyBlock(decodeBlock(fixture("byron-ebb-preprod")))).toBe(false);
  });
});
