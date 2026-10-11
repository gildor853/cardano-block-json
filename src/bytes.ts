const HEX = "0123456789abcdef";
const HEX_TABLE: string[] = [];
for (let i = 0; i < 256; i++) HEX_TABLE.push(HEX[i >> 4]! + HEX[i & 15]!);

/** Lower-case hex of a byte array. */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += HEX_TABLE[bytes[i]!]!;
  return out;
}

/** Parses an even-length hex string (no prefix, either case). Returns `undefined` when invalid. */
export function fromHex(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return undefined;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Decodes UTF-8; returns `undefined` if the bytes are not valid UTF-8. */
export function utf8OrUndefined(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
