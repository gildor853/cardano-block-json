import { describe, expect, it } from "vitest";
import {
  cborItemLength,
  CborMap,
  CborSimple,
  CborTag,
  decodeCbor,
  decodeCborDocument,
  encodeCbor,
} from "../src/cbor.js";
import { fromHex, toHex } from "../src/bytes.js";
import { isCardanoBlockError } from "../src/errors.js";

const h = (s: string): Uint8Array => fromHex(s.replace(/\s/g, ""))!;
const dec = (s: string) => decodeCbor(h(s));

function cborError(fn: () => unknown): { message: string; details: Record<string, unknown> | undefined } {
  try {
    fn();
  } catch (err) {
    expect(isCardanoBlockError(err, "CBOR_DECODE")).toBe(true);
    return { message: (err as Error).message, details: (err as { details?: Record<string, unknown> }).details as never };
  }
  throw new Error("expected CBOR_DECODE");
}

describe("CBOR decoder (RFC 8949 Appendix A vectors)", () => {
  it("integers", () => {
    expect(dec("00")).toBe(0n);
    expect(dec("17")).toBe(23n);
    expect(dec("1818")).toBe(24n);
    expect(dec("1903e8")).toBe(1000n);
    expect(dec("1a000f4240")).toBe(1000000n);
    expect(dec("1b000000e8d4a51000")).toBe(1000000000000n);
    expect(dec("1bffffffffffffffff")).toBe(18446744073709551615n);
    expect(dec("20")).toBe(-1n);
    expect(dec("3903e7")).toBe(-1000n);
    expect(dec("3bffffffffffffffff")).toBe(-18446744073709551616n);
  });

  it("floats and simple values", () => {
    expect(dec("f90000")).toBe(0);
    expect(dec("f93c00")).toBe(1);
    expect(dec("f97bff")).toBe(65504);
    expect(dec("f90001")).toBe(5.960464477539063e-8);
    expect(dec("f9c400")).toBe(-4);
    expect(dec("f97c00")).toBe(Infinity);
    expect(dec("f9fc00")).toBe(-Infinity);
    expect(Number.isNaN(dec("f97e00"))).toBe(true);
    expect(dec("fa47c35000")).toBe(100000);
    expect(dec("fb3ff199999999999a")).toBe(1.1);
    expect(dec("f4")).toBe(false);
    expect(dec("f5")).toBe(true);
    expect(dec("f6")).toBe(null);
    expect(dec("f7")).toBe(undefined);
    expect(dec("f0")).toEqual(new CborSimple(16));
    expect(dec("f8ff")).toEqual(new CborSimple(255));
  });

  it("strings, arrays, maps, tags", () => {
    expect(dec("4401020304")).toEqual(Uint8Array.of(1, 2, 3, 4));
    expect(dec("6449455446")).toBe("IETF");
    expect(dec("62c3bc")).toBe("ü");
    expect(dec("83010203")).toEqual([1n, 2n, 3n]);
    expect(dec("8301820203820405")).toEqual([1n, [2n, 3n], [4n, 5n]]);
    const m = dec("a201020304") as CborMap;
    expect(m.get(1)).toBe(2n);
    expect(m.get(3n)).toBe(4n);
    expect(m.has(5)).toBe(false);
    expect(m.size).toBe(2);
    expect((dec("a26161016162820203") as CborMap).get("b")).toEqual([2n, 3n]);
    const t = dec("c11a514b67b0") as CborTag;
    expect(t.tag).toBe(1n);
    expect(t.value).toBe(1363896240n);
  });

  it("indefinite-length items", () => {
    expect(dec("5f42010243030405ff")).toEqual(Uint8Array.of(1, 2, 3, 4, 5));
    expect(dec("7f657374726561646d696e67ff")).toBe("streaming");
    expect(dec("9fff")).toEqual([]);
    expect(dec("9f018202039f0405ffff")).toEqual([1n, [2n, 3n], [4n, 5n]]);
    expect((dec("bf61610161629f0203ffff") as CborMap).get("b")).toEqual([2n, 3n]);
  });

  it("records exact byte spans, including indefinite containers", () => {
    const bytes = h("83 01 9f 02 03 ff a1 04 82 05 06");
    const doc = decodeCborDocument(bytes);
    const root = doc.root as unknown[];
    expect(toHex(doc.raw(root as never))).toBe(toHex(bytes));
    expect(toHex(doc.rawChild(root as never, 0))).toBe("01");
    expect(toHex(doc.rawChild(root as never, 1))).toBe("9f0203ff");
    expect(toHex(doc.rawChild(root[1] as never, 1))).toBe("03");
    const m = root[2] as CborMap;
    expect(toHex(doc.rawChild(m, 0))).toBe("04");
    expect(toHex(doc.rawMapValue(m, 0))).toBe("820506");
    expect(() => doc.rawChild(root as never, 3)).toThrow();
    expect(() => doc.raw(5n)).toThrow();
  });

  it("rejects malformed input with CBOR_DECODE", () => {
    expect(cborError(() => dec("")).details?.["truncated"]).toBe(true);
    expect(cborError(() => dec("1a0001")).details?.["truncated"]).toBe(true);
    expect(cborError(() => dec("83 01 02")).details?.["truncated"]).toBe(true);
    expect(cborError(() => dec("5a ffffffff 00")).details?.["truncated"]).toBe(true);
    expect(cborError(() => dec("0102")).message).toMatch(/trailing/);
    expect(cborError(() => dec("1c")).message).toMatch(/additional information/);
    expect(cborError(() => dec("1f")).message).toMatch(/indefinite/);
    expect(cborError(() => dec("3f")).message).toMatch(/indefinite/);
    expect(cborError(() => dec("df00")).message).toMatch(/indefinite/);
    expect(cborError(() => dec("ff")).message).toMatch(/break/);
    expect(cborError(() => dec("8201ff")).message).toMatch(/break/);
    expect(cborError(() => dec("a1ff00")).message).toMatch(/break/);
    expect(cborError(() => dec("a101ff")).message).toMatch(/break/);
    expect(cborError(() => dec("c1ff")).message).toMatch(/break/);
    expect(cborError(() => dec("5f01ff")).message).toMatch(/chunk/);
    expect(cborError(() => dec("5f5f4100ffff")).message).toMatch(/chunk/);
    expect(cborError(() => dec("62c328")).message).toMatch(/UTF-8/);
    expect(cborError(() => dec("f818")).message).toMatch(/simple/);
    expect(cborError(() => dec("fc")).message).toMatch(/simple/);
    expect(cborError(() => dec("9b 0020000000000000 00")).message).toMatch(/too large/);
  });

  it("limits nesting depth", () => {
    const deep = new Uint8Array(300).fill(0x81);
    const bytes = new Uint8Array(301);
    bytes.set(deep);
    expect(cborError(() => decodeCbor(bytes)).message).toMatch(/depth/);
    expect(decodeCbor(bytes, { maxDepth: 400 })).toBeInstanceOf(Array);
  });

  it("does not pre-allocate for huge declared lengths", () => {
    // Array claiming 2^32-1 elements with 1 byte of content: truncated, no allocation.
    expect(cborError(() => dec("9affffffff00")).details?.["truncated"]).toBe(true);
    expect(cborError(() => dec("baffffffff00")).details?.["truncated"]).toBe(true);
  });

  it("cborItemLength reports complete items and waits for truncated ones", () => {
    expect(cborItemLength(h("8201020304"))).toBe(3);
    expect(cborItemLength(h("820102"))).toBe(3);
    expect(cborItemLength(h("8201"))).toBeUndefined();
    expect(cborItemLength(h("59ffff00"))).toBeUndefined();
    expect(() => cborItemLength(h("1c"))).toThrow();
  });
});

describe("CBOR encoder", () => {
  it("uses minimal heads and round-trips", () => {
    expect(toHex(encodeCbor(0))).toBe("00");
    expect(toHex(encodeCbor(23))).toBe("17");
    expect(toHex(encodeCbor(24))).toBe("1818");
    expect(toHex(encodeCbor(256))).toBe("190100");
    expect(toHex(encodeCbor(65536))).toBe("1a00010000");
    expect(toHex(encodeCbor(4294967296n))).toBe("1b0000000100000000");
    expect(toHex(encodeCbor(-1))).toBe("20");
    expect(toHex(encodeCbor(-500n))).toBe("3901f3");
    expect(toHex(encodeCbor("IETF"))).toBe("6449455446");
    expect(toHex(encodeCbor([true, false, null, undefined]))).toBe("84f5f4f6f7");
    expect(toHex(encodeCbor(new Map([[1, 2]])))).toBe("a10102");
    expect(toHex(encodeCbor(new CborMap([[1n, 2n]])))).toBe("a10102");
    expect(toHex(encodeCbor(new CborTag(24n, Uint8Array.of(1))))).toBe("d8184101");
    expect(toHex(encodeCbor(new CborSimple(16)))).toBe("f0");
    expect(toHex(encodeCbor(new CborSimple(99)))).toBe("f863");
    const v = [1n, [2n, Uint8Array.of(9)], "x", new CborTag(258n, [1n])];
    expect(decodeCbor(encodeCbor(v as never))).toEqual(v);
    expect(() => encodeCbor(1.5)).toThrow(RangeError);
    expect(() => encodeCbor(2n ** 64n)).toThrow(RangeError);
  });
});
