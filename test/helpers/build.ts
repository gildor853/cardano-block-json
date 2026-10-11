// Builds synthetic but structurally valid blocks (with correct body hash and size) for testing
// structures that are rare on chain.
import { blake2b256 } from "../../src/blake2b.js";
import { CborMap, CborTag, encodeCbor, type CborEncodable } from "../../src/cbor.js";
import { concatBytes } from "../../src/bytes.js";

export const b = (n: number, fill = 1): Uint8Array => new Uint8Array(n).fill(fill);
export const tag = (t: number | bigint, v: CborEncodable): CborTag => new CborTag(BigInt(t), v as never);
export const set = (items: CborEncodable[]): CborTag => tag(258, items);
export const m = (...entries: Array<[CborEncodable, CborEncodable]>): CborMap => new CborMap(entries as never);

export interface BlockParts {
  eraTag?: number;
  bodies: CborEncodable[];
  witnesses: CborEncodable[];
  aux?: CborMap;
  invalid?: number[] | null;
  praos?: boolean;
  /** Override the header body (for malformed-header tests). */
  headerBody?: CborEncodable[];
}

/** Returns `[eraTag, block]` CBOR bytes. Body segments are encoded once and spliced in as-is. */
export function buildBlock(p: BlockParts): Uint8Array {
  const segs = [encodeCbor(p.bodies), encodeCbor(p.witnesses), encodeCbor(p.aux ?? m())];
  if (p.invalid !== null) segs.push(encodeCbor(p.invalid ?? []));
  const bodyHash = blake2b256(concatBytes(segs.map((s) => blake2b256(s))));
  const bodySize = segs.reduce((n, s) => n + s.length, 0);
  const praos = p.praos ?? true;
  const headerBody: CborEncodable[] =
    p.headerBody ??
    (praos
      ? [42, 1000, b(32, 9), b(32, 2), b(32, 3), [b(64), b(80)], bodySize, bodyHash, [b(32, 4), 1, 2, b(64, 5)], [10, 0]]
      : [42, 1000, null, b(32, 2), b(32, 3), [b(64), b(80)], [b(64), b(80)], bodySize, bodyHash, b(32, 4), 1, 2, b(64, 5), 2, 0]);
  const header = encodeCbor([headerBody, b(448, 6)]);
  const n = segs.length + 1;
  const block = concatBytes([Uint8Array.of(0x80 | n), header, ...segs]);
  return concatBytes([Uint8Array.of(0x82), encodeCbor(p.eraTag ?? 7), block]);
}

export const input = (i = 0): CborEncodable[] => [b(32, 0xaa), i];
export const ENT_ADDR = Uint8Array.of(0x61, ...b(28, 0x11));
export const REWARD = Uint8Array.of(0xe1, ...b(28, 0x22));
export const KEY = b(28, 0x33);
export const cred = (t: 0 | 1 = 0): CborEncodable[] => [t, KEY];
export const ANCHOR: CborEncodable[] = ["https://example.org/a.json", b(32, 0x44)];

export function body(extra: Array<[number, CborEncodable]> = []): CborMap {
  return m([0, set([input()])], [1, [[ENT_ADDR, 1000000]]], [2, 170000], ...(extra as Array<[CborEncodable, CborEncodable]>));
}
