import { describe, expect, it } from "vitest";
import { CborTag, decodeCbor, encodeCbor } from "../src/cbor.js";
import { concatBytes, toHex } from "../src/bytes.js";
import { isCardanoBlockError } from "../src/errors.js";
import { parseBlockFetch, parseHandshakeReply, proposeVersions, requestRange } from "../src/network/messages.js";
import { Demuxer, encodeSegments, MAX_SDU_PAYLOAD } from "../src/network/mux.js";
import { isPrivateAddress, NETWORK_MAGIC, networkMagic, parsePoint, parseRelay } from "../src/network/options.js";

const HASH = "9c588338b007a725620937bdc2f481e8c6415ae369596af77413734213b772ce";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (isCardanoBlockError(err)) return err.code;
    throw err;
  }
  return "none";
}

describe("parseRelay", () => {
  it("accepts host:port, [ipv6]:port and objects", () => {
    expect(parseRelay("relays-new.cardano-mainnet.iohk.io:3001")).toEqual({ host: "relays-new.cardano-mainnet.iohk.io", port: 3001 });
    expect(parseRelay(" 1.2.3.4:6000 ")).toEqual({ host: "1.2.3.4", port: 6000 });
    expect(parseRelay("[2001:db8::1]:3001")).toEqual({ host: "2001:db8::1", port: 3001 });
    expect(parseRelay({ host: "example.org", port: 1 })).toEqual({ host: "example.org", port: 1 });
    expect(parseRelay({ host: "example.org.", port: 65535 })).toEqual({ host: "example.org.", port: 65535 });
  });

  it("rejects anything else", () => {
    for (const bad of [
      "",
      "host",
      "host:",
      ":3001",
      "host:0",
      "host:65536",
      "host:30a1",
      "tcp://host:3001",
      "user@host:3001",
      "host:3001/path",
      "ho st:3001",
      "2001:db8::1:3001",
      "[not-ip]:3001",
      "-bad-.org:3001",
      "a".repeat(64) + ".org:3001",
      "x".repeat(301),
    ]) {
      expect(code(() => parseRelay(bad)), bad).toBe("INVALID_ARGUMENT");
    }
    expect(code(() => parseRelay({ host: "h", port: 1.5 }))).toBe("INVALID_ARGUMENT");
    expect(code(() => parseRelay({ host: 5 as never, port: 1 }))).toBe("INVALID_ARGUMENT");
    expect(code(() => parseRelay(42 as never))).toBe("INVALID_ARGUMENT");
  });
});

describe("parsePoint", () => {
  it("accepts objects and strings", () => {
    expect(parsePoint({ slot: 75600078, hash: HASH })).toEqual({ slot: 75600078n, hash: HASH });
    expect(parsePoint({ slot: 75600078n, hash: `0x${HASH.toUpperCase()}` })).toEqual({ slot: 75600078n, hash: HASH });
    expect(parsePoint({ slot: " 75600078 ", hash: HASH }).slot).toBe(75600078n);
    expect(parsePoint(`75600078.${HASH}`).slot).toBe(75600078n);
    expect(parsePoint(`75600078:${HASH}`).slot).toBe(75600078n);
  });

  it("refuses a hash without a slot, with an explanation", () => {
    expect(() => parsePoint(HASH)).toThrow(/hash alone is not enough/);
    expect(() => parsePoint({ hash: HASH } as never)).toThrow(/slot is required/);
    expect(() => parsePoint({ slot: "", hash: HASH })).toThrow(/slot is required/);
  });

  it("rejects malformed points", () => {
    for (const bad of [
      { slot: -1, hash: HASH },
      { slot: 1.5, hash: HASH },
      { slot: "12a", hash: HASH },
      { slot: 2n ** 64n, hash: HASH },
      { slot: 1, hash: "abcd" },
      { slot: 1, hash: 5 },
      { slot: 1, hash: "zz".repeat(32) },
    ]) {
      expect(code(() => parsePoint(bad as never))).toBe("INVALID_ARGUMENT");
    }
    expect(code(() => parsePoint("nope"))).toBe("INVALID_ARGUMENT");
    expect(code(() => parsePoint(null as never))).toBe("INVALID_ARGUMENT");
  });
});

describe("networkMagic", () => {
  it("maps names and validates numbers", () => {
    expect(NETWORK_MAGIC).toEqual({ mainnet: 764824073, preprod: 1, preview: 2 });
    expect(networkMagic(undefined)).toBe(764824073);
    expect(networkMagic("preprod")).toBe(1);
    expect(networkMagic("preview")).toBe(2);
    expect(networkMagic(42)).toBe(42);
    expect(code(() => networkMagic("testnet" as never))).toBe("INVALID_ARGUMENT");
    expect(code(() => networkMagic(-1))).toBe("INVALID_ARGUMENT");
    expect(code(() => networkMagic(2 ** 32))).toBe("INVALID_ARGUMENT");
    expect(code(() => networkMagic(1.5))).toBe("INVALID_ARGUMENT");
  });
});

describe("isPrivateAddress", () => {
  it("classifies IPv4 and IPv6", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
      "::",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "2001:db8::1",
      "fe80::1%eth0",
      "not-an-ip",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2a01:4f8::1", "::ffff:8.8.8.8", "2606:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("handshake and BlockFetch codecs", () => {
  it("encodes MsgProposeVersions", () => {
    expect(toHex(proposeVersions(1, [14]))).toBe("8200a10e8401f500f4");
    const decoded = decodeCbor(proposeVersions(764824073, [16, 14, 15])) as unknown[];
    expect(decoded[0]).toBe(0n);
    const table = decoded[1] as { entries: Array<[bigint, unknown[]]> };
    expect(table.entries.map((e) => e[0])).toEqual([14n, 15n, 16n]);
    expect(table.entries[2]![1]).toEqual([764824073n, true, 0n, false, false]);
  });

  it("parses replies", () => {
    expect(parseHandshakeReply(decodeCbor(encodeCbor([1, 14, [1, false, 0, false]])))).toEqual({ type: "accept", version: 14, magic: 1 });
    expect(parseHandshakeReply(decodeCbor(encodeCbor([1, 16, null])))).toEqual({ type: "accept", version: 16, magic: undefined });
    expect(parseHandshakeReply(decodeCbor(encodeCbor([2, [0, [14, 15]]])))).toMatchObject({ type: "refuse", details: { versions: [14, 15] } });
    expect(parseHandshakeReply(decodeCbor(encodeCbor([2, [1, 14, "bad"]])))).toMatchObject({
      type: "refuse",
      details: { kind: "HandshakeDecodeError", message: "bad" },
    });
    expect(parseHandshakeReply(decodeCbor(encodeCbor([2, [2, 15, "no"]])))).toMatchObject({ details: { kind: "Refused", version: 15 } });
    expect(parseHandshakeReply(decodeCbor(encodeCbor([2, "?"])))).toMatchObject({ type: "refuse" });
    for (const bad of [[3, new Map()], [0, new Map()], [9], ["x"], [1, "v"]]) {
      expect(code(() => parseHandshakeReply(decodeCbor(encodeCbor(bad as never))))).toBe("PROTOCOL");
    }
    expect(code(() => parseHandshakeReply(5n))).toBe("PROTOCOL");
  });

  it("encodes MsgRequestRange and parses BlockFetch messages", () => {
    expect(toHex(requestRange({ slot: 5n, hash: "00".repeat(32) }, { slot: 5n, hash: "00".repeat(32) }))).toBe(
      `8300820558200${"0".repeat(63)}820558200${"0".repeat(63)}`,
    );
    expect(parseBlockFetch([2n])).toEqual({ type: "startBatch" });
    expect(parseBlockFetch([3n])).toEqual({ type: "noBlocks" });
    expect(parseBlockFetch([5n])).toEqual({ type: "batchDone" });
    expect(parseBlockFetch([4n, new CborTag(24n, Uint8Array.of(1))])).toEqual({ type: "block", bytes: Uint8Array.of(1) });
    expect(parseBlockFetch([4n, Uint8Array.of(2)])).toEqual({ type: "block", bytes: Uint8Array.of(2) });
    expect(code(() => parseBlockFetch([4n, "x"]))).toBe("PROTOCOL");
    expect(code(() => parseBlockFetch([0n]))).toBe("PROTOCOL");
    expect(code(() => parseBlockFetch("x"))).toBe("PROTOCOL");
  });
});

describe("multiplexer", () => {
  const responder = (protocol: number, payload: Uint8Array): Uint8Array => {
    const s = encodeSegments(protocol, payload, () => 7);
    for (let off = 0; off < s.length; ) {
      const len = (s[off + 6]! << 8) | s[off + 7]!;
      s[off + 4] = s[off + 4]! | 0x80;
      off += 8 + len;
    }
    return s;
  };

  it("frames SDUs with timestamp, protocol and length", () => {
    expect(toHex(encodeSegments(3, Uint8Array.of(0x81, 0x01), () => 0x01020304))).toBe("0102030400030002" + "8101");
    expect(toHex(encodeSegments(0, new Uint8Array(), () => 0))).toBe("0000000000000000");
    const big = new Uint8Array(MAX_SDU_PAYLOAD * 2 + 5);
    const framed = encodeSegments(3, big, () => 0);
    expect(framed.length).toBe(big.length + 3 * 8);
  });

  it("reassembles messages split across SDUs and TCP chunks", () => {
    const msg = encodeCbor([4, new CborTag(24n, new Uint8Array(30000).fill(7))]);
    const wire = concatBytes([responder(3, msg), responder(0, encodeCbor([1, 14, [1, false, 0, false]]))]);
    const d = new Demuxer(1 << 20);
    const out = [];
    for (let i = 0; i < wire.length; i += 997) out.push(...d.push(wire.subarray(i, i + 997)));
    expect(out.map((m) => m.protocol)).toEqual([3, 0]);
    expect(out[0]!.bytes).toEqual(msg);
  });

  it("splits several messages carried in one SDU", () => {
    const d = new Demuxer(1024);
    const out = d.push(responder(3, concatBytes([encodeCbor([2]), encodeCbor([5])])));
    expect(out.map((m) => m.item)).toEqual([[2n], [5n]]);
  });

  it("rejects oversize messages, initiator traffic and malformed CBOR", () => {
    const d = new Demuxer(16);
    expect(code(() => d.push(responder(3, new Uint8Array(40).fill(0x59))))).toBe("PROTOCOL");
    expect(code(() => new Demuxer(1024).push(encodeSegments(2, encodeCbor([0]), () => 0)))).toBe("PROTOCOL");
    expect(code(() => new Demuxer(1024).push(responder(3, Uint8Array.of(0x1c))))).toBe("CBOR_DECODE");
  });
});
