// Zero-dependency CBOR (RFC 8949) decoder that keeps the exact source byte range of every
// container, which Cardano needs for hashing (tx ids, header hashes, datum and script hashes).
// Also a tiny encoder for the handful of mini-protocol messages we send.

import { CardanoBlockError } from "./errors.js";

/** A CBOR map, kept as an ordered list of entries so that non-string keys and duplicates survive. */
export class CborMap {
  readonly entries: Array<[CborItem, CborItem]>;
  constructor(entries: Array<[CborItem, CborItem]> = []) {
    this.entries = entries;
  }
  get size(): number {
    return this.entries.length;
  }
  /** First value whose key is the given unsigned integer / text key. */
  get(key: number | bigint | string): CborItem | undefined {
    const want = typeof key === "number" ? BigInt(key) : key;
    for (const [k, v] of this.entries) if (k === want) return v;
    return undefined;
  }
  has(key: number | bigint | string): boolean {
    const want = typeof key === "number" ? BigInt(key) : key;
    return this.entries.some(([k]) => k === want);
  }
}

/** A tagged CBOR item (major type 6). */
export class CborTag {
  constructor(
    readonly tag: bigint,
    readonly value: CborItem,
  ) {}
}

/** An unassigned CBOR simple value. */
export class CborSimple {
  constructor(readonly value: number) {}
}

/**
 * Decoded CBOR item. Integers are always `bigint` (major types 0/1); IEEE floats are `number`.
 * Byte strings are `Uint8Array` (indefinite-length chunks are concatenated), text strings `string`.
 */
export type CborItem =
  | bigint
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | CborItem[]
  | CborMap
  | CborTag
  | CborSimple;

interface Span {
  start: number;
  end: number;
  /** Arrays: start of each element. Maps: start of key0, value0, key1, value1, … Tags: start of content. */
  children: number[];
  /** Indefinite-length container (ends with a 0xff break byte). */
  indefinite?: boolean;
}

export interface CborDecodeOptions {
  /** Maximum nesting depth (default 256). */
  maxDepth?: number;
}

const BREAK = Symbol("break");

/**
 * A decoded CBOR document: the root item plus the byte spans of every array, map and tag,
 * so callers can recover the exact original encoding of any sub-item.
 */
export class CborDocument {
  readonly bytes: Uint8Array;
  readonly root: CborItem;
  /** Offset just past the root item (equals `bytes.length` when the whole input was consumed). */
  readonly end: number;
  private readonly spans: WeakMap<object, Span>;

  /** @internal */
  constructor(bytes: Uint8Array, root: CborItem, end: number, spans: WeakMap<object, Span>) {
    this.bytes = bytes;
    this.root = root;
    this.end = end;
    this.spans = spans;
  }

  /** Original bytes of an array, map or tag item from this document. */
  raw(item: CborItem): Uint8Array {
    const s = typeof item === "object" && item !== null && !(item instanceof Uint8Array) ? this.spans.get(item) : undefined;
    if (!s) throw new CardanoBlockError("CBOR_DECODE", "internal: no byte span recorded for item");
    return this.bytes.subarray(s.start, s.end);
  }

  /** Original bytes of the i-th element of an array, or the i-th key/value slot of a map (key = 2i, value = 2i+1). */
  rawChild(container: CborItem[] | CborMap | CborTag, index: number): Uint8Array {
    const s = this.spans.get(container);
    if (!s || index < 0 || index >= s.children.length) {
      throw new CardanoBlockError("CBOR_DECODE", "internal: child span out of range");
    }
    const start = s.children[index]!;
    const end = index + 1 < s.children.length ? s.children[index + 1]! : s.end - (s.indefinite ? 1 : 0);
    return this.bytes.subarray(start, end);
  }

  /** Raw bytes of the value of map entry `i`. */
  rawMapValue(map: CborMap, entryIndex: number): Uint8Array {
    return this.rawChild(map, entryIndex * 2 + 1);
  }
}


class Decoder {
  pos: number;
  readonly view: DataView;
  readonly spans = new WeakMap<object, Span>();
  constructor(
    readonly bytes: Uint8Array,
    start: number,
    readonly maxDepth: number,
  ) {
    this.pos = start;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  fail(message: string, at = this.pos): never {
    throw new CardanoBlockError("CBOR_DECODE", `${message} (at byte ${at})`, { offset: at });
  }

  need(n: number): void {
    if (this.pos + n > this.bytes.length) this.truncated();
  }

  truncated(): never {
    throw new CardanoBlockError("CBOR_DECODE", `unexpected end of CBOR input (at byte ${this.pos})`, {
      offset: this.pos,
      truncated: true,
    });
  }

  readArg(info: number): bigint | number {
    if (info < 24) return info;
    switch (info) {
      case 24:
        this.need(1);
        return this.bytes[this.pos++]!;
      case 25: {
        this.need(2);
        const v = this.view.getUint16(this.pos);
        this.pos += 2;
        return v;
      }
      case 26: {
        this.need(4);
        const v = this.view.getUint32(this.pos);
        this.pos += 4;
        return v;
      }
      case 27: {
        this.need(8);
        const v = this.view.getBigUint64(this.pos);
        this.pos += 8;
        return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
      }
      default:
        return this.fail(`invalid additional information ${info}`, this.pos - 1);
    }
  }

  /** Length argument checked against the remaining input (each element needs >= `minBytesPerUnit` bytes). */
  readLength(info: number, minBytesPerUnit: number): number {
    const at = this.pos - 1;
    const n = this.readArg(info);
    if (typeof n === "bigint") return this.fail(`declared length ${n} is too large`, at);
    if (n * minBytesPerUnit > this.bytes.length - this.pos) this.truncatedAt(at, n);
    return n;
  }

  truncatedAt(at: number, n: number): never {
    throw new CardanoBlockError("CBOR_DECODE", `declared length ${n} exceeds remaining input (at byte ${at})`, {
      offset: at,
      truncated: true,
    });
  }

  item(depth: number): CborItem | typeof BREAK {
    if (depth > this.maxDepth) this.fail(`maximum nesting depth ${this.maxDepth} exceeded`);
    this.need(1);
    const start = this.pos;
    const ib = this.bytes[this.pos++]!;
    const major = ib >> 5;
    const info = ib & 31;
    switch (major) {
      case 0: {
        const v = this.readArg(info === 31 ? this.fail("indefinite length not allowed for integers", start) : info);
        return BigInt(v);
      }
      case 1: {
        const v = this.readArg(info === 31 ? this.fail("indefinite length not allowed for integers", start) : info);
        return -1n - BigInt(v);
      }
      case 2:
      case 3: {
        let data: Uint8Array;
        if (info === 31) {
          const chunks: Uint8Array[] = [];
          let total = 0;
          for (;;) {
            this.need(1);
            if (this.bytes[this.pos] === 0xff) {
              this.pos++;
              break;
            }
            const cs = this.pos;
            const cb = this.bytes[this.pos++]!;
            if (cb >> 5 !== major || (cb & 31) === 31) this.fail("invalid chunk in indefinite-length string", cs);
            const len = this.readLength(cb & 31, 1);
            chunks.push(this.bytes.subarray(this.pos, this.pos + len));
            this.pos += len;
            total += len;
          }
          data = new Uint8Array(total);
          let at = 0;
          for (const c of chunks) {
            data.set(c, at);
            at += c.length;
          }
        } else {
          const len = this.readLength(info, 1);
          data = this.bytes.slice(this.pos, this.pos + len);
          this.pos += len;
        }
        if (major === 2) return data;
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(data);
        } catch {
          return this.fail("invalid UTF-8 in text string", start);
        }
      }
      case 4: {
        const arr: CborItem[] = [];
        const span: Span = { start, end: 0, children: [] };
        if (info === 31) {
          span.indefinite = true;
          for (;;) {
            const cs = this.pos;
            const v = this.item(depth + 1);
            if (v === BREAK) break;
            span.children.push(cs);
            arr.push(v);
          }
        } else {
          const n = this.readLength(info, 1);
          for (let i = 0; i < n; i++) {
            span.children.push(this.pos);
            const v = this.item(depth + 1);
            if (v === BREAK) this.fail("unexpected break", this.pos - 1);
            arr.push(v);
          }
        }
        span.end = this.pos;
        this.spans.set(arr, span);
        return arr;
      }
      case 5: {
        const map = new CborMap();
        const span: Span = { start, end: 0, children: [] };
        const readEntry = (k: CborItem, ks: number): void => {
          const vs = this.pos;
          const v = this.item(depth + 1);
          if (v === BREAK) this.fail("unexpected break in map value", this.pos - 1);
          span.children.push(ks, vs);
          map.entries.push([k, v]);
        };
        if (info === 31) {
          span.indefinite = true;
          for (;;) {
            const ks = this.pos;
            const k = this.item(depth + 1);
            if (k === BREAK) break;
            readEntry(k, ks);
          }
        } else {
          const n = this.readLength(info, 2);
          for (let i = 0; i < n; i++) {
            const ks = this.pos;
            const k = this.item(depth + 1);
            if (k === BREAK) this.fail("unexpected break in map key", this.pos - 1);
            readEntry(k, ks);
          }
        }
        span.end = this.pos;
        this.spans.set(map, span);
        return map;
      }
      case 6: {
        if (info === 31) this.fail("indefinite length not allowed for tags", start);
        const tag = BigInt(this.readArg(info));
        const cs = this.pos;
        const v = this.item(depth + 1);
        if (v === BREAK) this.fail("unexpected break after tag", this.pos - 1);
        const t = new CborTag(tag, v);
        this.spans.set(t, { start, end: this.pos, children: [cs] });
        return t;
      }
      default: {
        // major 7
        switch (info) {
          case 20:
            return false;
          case 21:
            return true;
          case 22:
            return null;
          case 23:
            return undefined;
          case 24: {
            this.need(1);
            const v = this.bytes[this.pos++]!;
            if (v < 32) this.fail("invalid two-byte simple value", start);
            return new CborSimple(v);
          }
          case 25: {
            this.need(2);
            const h = this.view.getUint16(this.pos);
            this.pos += 2;
            return halfToFloat(h);
          }
          case 26: {
            this.need(4);
            const f = this.view.getFloat32(this.pos);
            this.pos += 4;
            return f;
          }
          case 27: {
            this.need(8);
            const f = this.view.getFloat64(this.pos);
            this.pos += 8;
            return f;
          }
          case 31:
            return BREAK;
          default:
            if (info < 20) return new CborSimple(info);
            return this.fail(`invalid simple/float additional information ${info}`, start);
        }
      }
    }
  }
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/**
 * Decodes one CBOR item starting at `offset`. Unless `allowTrailing` is set, any bytes after the
 * item cause a `CBOR_DECODE` error.
 */
export function decodeCborDocument(
  bytes: Uint8Array,
  options: CborDecodeOptions & { offset?: number; allowTrailing?: boolean } = {},
): CborDocument {
  const d = new Decoder(bytes, options.offset ?? 0, options.maxDepth ?? 256);
  const root = d.item(0);
  if (root === BREAK) d.fail("unexpected break", d.pos - 1);
  if (!options.allowTrailing && d.pos !== bytes.length) {
    d.fail(`${bytes.length - d.pos} trailing byte(s) after CBOR item`);
  }
  return new CborDocument(bytes, root as CborItem, d.pos, d.spans);
}

/** Decodes a single CBOR item (convenience wrapper around {@link decodeCborDocument}). */
export function decodeCbor(bytes: Uint8Array, options: CborDecodeOptions = {}): CborItem {
  return decodeCborDocument(bytes, options).root;
}

/**
 * Returns the byte length of the first complete CBOR item in `bytes`, or `undefined` when the
 * input ends before the item does. Throws on malformed CBOR.
 */
export function cborItemLength(bytes: Uint8Array, maxDepth = 256): number | undefined {
  try {
    return decodeCborDocument(bytes, { allowTrailing: true, maxDepth }).end;
  } catch (err) {
    if (err instanceof CardanoBlockError && err.details?.["truncated"] === true) return undefined;
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Encoder (subset): integers, byte/text strings, arrays, maps, tags, bools, null/undefined. No floats.

export type CborEncodable =
  | bigint
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | readonly CborEncodable[]
  | ReadonlyMap<CborEncodable, CborEncodable>
  | CborTag
  | CborMap
  | CborSimple;

function head(major: number, n: bigint, out: number[]): void {
  const m = major << 5;
  if (n < 24n) out.push(m | Number(n));
  else if (n < 0x100n) out.push(m | 24, Number(n));
  else if (n < 0x10000n) out.push(m | 25, Number(n >> 8n), Number(n & 0xffn));
  else if (n < 0x100000000n) {
    out.push(m | 26);
    for (let s = 24n; s >= 0n; s -= 8n) out.push(Number((n >> s) & 0xffn));
  } else if (n < 0x10000000000000000n) {
    out.push(m | 27);
    for (let s = 56n; s >= 0n; s -= 8n) out.push(Number((n >> s) & 0xffn));
  } else throw new RangeError("CBOR integer out of 64-bit range");
}

function enc(v: CborEncodable, out: number[]): void {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new RangeError("only safe integers can be CBOR-encoded");
    v = BigInt(v);
  }
  if (typeof v === "bigint") {
    if (v >= 0n) head(0, v, out);
    else head(1, -1n - v, out);
  } else if (typeof v === "string") {
    const b = new TextEncoder().encode(v);
    head(3, BigInt(b.length), out);
    for (const x of b) out.push(x);
  } else if (v instanceof Uint8Array) {
    head(2, BigInt(v.length), out);
    for (const x of v) out.push(x);
  } else if (v === true) out.push(0xf5);
  else if (v === false) out.push(0xf4);
  else if (v === null) out.push(0xf6);
  else if (v === undefined) out.push(0xf7);
  else if (Array.isArray(v)) {
    head(4, BigInt(v.length), out);
    for (const x of v) enc(x, out);
  } else if (v instanceof CborSimple) {
    if (v.value < 24) out.push(0xe0 | v.value);
    else out.push(0xf8, v.value & 0xff);
  } else if (v instanceof CborTag) {
    head(6, v.tag, out);
    enc(v.value as CborEncodable, out);
  } else if (v instanceof CborMap) {
    head(5, BigInt(v.size), out);
    for (const [k, x] of v.entries) {
      enc(k as CborEncodable, out);
      enc(x as CborEncodable, out);
    }
  } else {
    const m = v as ReadonlyMap<CborEncodable, CborEncodable>;
    head(5, BigInt(m.size), out);
    for (const [k, x] of m) {
      enc(k, out);
      enc(x, out);
    }
  }
}

/** Encodes a value with the minimal (canonical-length) CBOR heads. */
export function encodeCbor(value: CborEncodable): Uint8Array {
  const out: number[] = [];
  enc(value, out);
  return Uint8Array.from(out);
}
