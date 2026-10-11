// Plutus data and transaction metadata → detailed-schema JSON (as used by cardano-cli).
import { CborMap, CborTag, type CborItem } from "./cbor.js";
import { toHex } from "./bytes.js";
import { bignum, fail } from "./read.js";
import type { Metadatum, PlutusData } from "./types.js";

function ctorNumber(n: bigint): number | bigint {
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
}

export function plutusData(item: CborItem, path: string): PlutusData {
  if (typeof item === "bigint") return { int: item };
  if (item instanceof Uint8Array) return { bytes: toHex(item) };
  if (Array.isArray(item)) return { list: item.map((x, i) => plutusData(x, `${path}[${i}]`)) };
  if (item instanceof CborMap) {
    return { map: item.entries.map(([k, v], i) => ({ k: plutusData(k, `${path}.k${i}`), v: plutusData(v, `${path}.v${i}`) })) };
  }
  if (item instanceof CborTag) {
    const t = item.tag;
    if ((t === 2n || t === 3n) && item.value instanceof Uint8Array) return { int: bignum(item) };
    const fieldsOf = (v: CborItem): PlutusData[] => {
      if (!Array.isArray(v)) fail(path, "constructor fields must be an array");
      return v.map((x, i) => plutusData(x, `${path}.fields[${i}]`));
    };
    if (t >= 121n && t <= 127n) return { constructor: Number(t - 121n), fields: fieldsOf(item.value) };
    if (t >= 1280n && t <= 1400n) return { constructor: Number(t - 1280n + 7n), fields: fieldsOf(item.value) };
    if (t === 102n) {
      const v = item.value;
      if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "bigint" || v[0] < 0n) {
        fail(path, "tag 102 constructor must be [alternative, fields]");
      }
      return { constructor: ctorNumber(v[0]), fields: fieldsOf(v[1]) };
    }
    fail(path, `unexpected tag ${t} in Plutus data`);
  }
  return fail(path, "invalid Plutus data item");
}

export function metadatum(item: CborItem, path: string): Metadatum {
  if (typeof item === "bigint") return { int: item };
  if (item instanceof Uint8Array) return { bytes: toHex(item) };
  if (typeof item === "string") return { string: item };
  if (Array.isArray(item)) return { list: item.map((x, i) => metadatum(x, `${path}[${i}]`)) };
  if (item instanceof CborMap) {
    return { map: item.entries.map(([k, v], i) => ({ k: metadatum(k, `${path}.k${i}`), v: metadatum(v, `${path}.v${i}`) })) };
  }
  if (item instanceof CborTag && (item.tag === 2n || item.tag === 3n) && item.value instanceof Uint8Array) {
    return { int: bignum(item) };
  }
  return fail(path, "invalid metadatum");
}
