export interface ToJsonOptions {
  /**
   * How to render `bigint` values:
   * - `"string"` (default): always a decimal string — lossless and JSON-safe.
   * - `"number"`: a JSON number when it is a safe integer, otherwise a decimal string.
   */
  bigint?: "string" | "number";
}

/**
 * Returns a deep copy of a decoded block (or any value from this library) that `JSON.stringify`
 * can handle: `bigint` → string (or number, see options), `Uint8Array` → hex, `undefined` fields dropped.
 */
export function toJson(value: unknown, options: ToJsonOptions = {}): unknown {
  const asNumber = options.bigint === "number";
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const walk = (v: unknown): unknown => {
    if (typeof v === "bigint") return asNumber && v <= max && v >= -max ? Number(v) : v.toString();
    if (v instanceof Uint8Array) {
      let s = "";
      for (const b of v) s += b.toString(16).padStart(2, "0");
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value);
}

/** `JSON.stringify(toJson(value, options), null, indent)`. */
export function stringifyBlock(value: unknown, options: ToJsonOptions & { indent?: number } = {}): string {
  return JSON.stringify(toJson(value, options), null, options.indent ?? 2);
}
