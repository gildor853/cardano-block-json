// Typed accessors over decoded CBOR that fail with a path-qualified BLOCK_DECODE error.
import { CborMap, CborTag, type CborDocument, type CborItem } from "./cbor.js";
import { toHex } from "./bytes.js";
import { CardanoBlockError } from "./errors.js";

export interface Ctx {
  doc: CborDocument;
  warnings: string[];
  includeCbor: boolean;
}

export function fail(path: string, message: string): never {
  throw new CardanoBlockError("BLOCK_DECODE", `${path}: ${message}`, { path });
}

function describe(item: CborItem): string {
  if (item === null) return "null";
  if (item === undefined) return "undefined";
  if (typeof item === "bigint") return "integer";
  if (typeof item === "number") return "float";
  if (typeof item === "string") return "text";
  if (typeof item === "boolean") return "boolean";
  if (item instanceof Uint8Array) return "bytes";
  if (Array.isArray(item)) return `array(${item.length})`;
  if (item instanceof CborMap) return "map";
  if (item instanceof CborTag) return `tag(${item.tag})`;
  return "simple";
}

export function arr(item: CborItem, path: string, minLen = 0): CborItem[] {
  if (!Array.isArray(item)) fail(path, `expected array, got ${describe(item)}`);
  if (item.length < minLen) fail(path, `expected at least ${minLen} elements, got ${item.length}`);
  return item;
}

export function map(item: CborItem, path: string): CborMap {
  if (!(item instanceof CborMap)) fail(path, `expected map, got ${describe(item)}`);
  return item;
}

export function bytes(item: CborItem, path: string, len?: number): Uint8Array {
  if (!(item instanceof Uint8Array)) fail(path, `expected bytes, got ${describe(item)}`);
  if (len !== undefined && item.length !== len) fail(path, `expected ${len} bytes, got ${item.length}`);
  return item;
}

export function hex(item: CborItem, path: string, len?: number): string {
  return toHex(bytes(item, path, len));
}

export function text(item: CborItem, path: string): string {
  if (typeof item !== "string") fail(path, `expected text, got ${describe(item)}`);
  return item;
}

export function int(item: CborItem, path: string): bigint {
  if (typeof item !== "bigint") {
    // Big integers (tags 2/3) are allowed wherever an integer is.
    if (item instanceof CborTag && (item.tag === 2n || item.tag === 3n) && item.value instanceof Uint8Array) {
      return bignum(item);
    }
    fail(path, `expected integer, got ${describe(item)}`);
  }
  return item;
}

export function uint(item: CborItem, path: string): bigint {
  const v = int(item, path);
  if (v < 0n) fail(path, "expected unsigned integer");
  return v;
}

/** Unsigned integer that must fit a JS number (indices, small enums). */
export function small(item: CborItem, path: string): number {
  const v = uint(item, path);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) fail(path, "integer too large");
  return Number(v);
}

export function bool(item: CborItem, path: string): boolean {
  if (typeof item !== "boolean") fail(path, `expected boolean, got ${describe(item)}`);
  return item;
}

export function bignum(tag: CborTag): bigint {
  const b = tag.value as Uint8Array;
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return tag.tag === 2n ? n : -1n - n;
}

/** Unwraps CBOR tag 258 (Conway sets) and returns the array. */
export function set(item: CborItem, path: string): CborItem[] {
  if (item instanceof CborTag && item.tag === 258n) return arr(item.value, path);
  return arr(item, path);
}

/** Like {@link set} but also returns the array object (for raw-span lookups). */
export function unwrapSet(item: CborItem): CborItem {
  return item instanceof CborTag && item.tag === 258n ? item.value : item;
}

export function rational(item: CborItem, path: string): { numerator: bigint; denominator: bigint } {
  const inner = item instanceof CborTag && item.tag === 30n ? item.value : item;
  const a = arr(inner, path, 2);
  return { numerator: int(a[0], `${path}[0]`), denominator: uint(a[1], `${path}[1]`) };
}

export function nullable<T>(item: CborItem, fn: (x: CborItem) => T): T | null {
  return item === null || item === undefined ? null : fn(item);
}

/** Hex of the original CBOR encoding of a container item. */
export function rawHex(ctx: Ctx, item: CborItem): string {
  return toHex(ctx.doc.raw(item));
}

/** Map entries keyed by small unsigned integers; other keys are reported and skipped. */
export function intKeyed(m: CborMap, path: string, ctx: Ctx): Array<[number, CborItem, number]> {
  const out: Array<[number, CborItem, number]> = [];
  m.entries.forEach(([k, v], i) => {
    if (typeof k === "bigint" && k >= 0n && k <= 0xffffffffn) out.push([Number(k), v, i]);
    else ctx.warnings.push(`${path}: ignored non-integer map key`);
  });
  return out;
}
