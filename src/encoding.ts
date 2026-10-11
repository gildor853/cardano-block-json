// Encode-only bech32 (BIP-173, without the 90-character limit, as used by Cardano/CIP-5)
// and base58 (Bitcoin alphabet, as used by Byron addresses).

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk;
}

/** Bech32-encodes `bytes` under the human-readable prefix `hrp` (lower-case). */
export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  const expanded: number[] = [];
  for (let i = 0; i < hrp.length; i++) expanded.push(hrp.charCodeAt(i) >> 5);
  expanded.push(0);
  for (let i = 0; i < hrp.length; i++) expanded.push(hrp.charCodeAt(i) & 31);
  const mod = polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  let out = hrp + "1";
  for (const w of words) out += CHARSET[w];
  for (let i = 0; i < 6; i++) out += CHARSET[(mod >>> (5 * (5 - i))) & 31];
  return out;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin alphabet) encoding. */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]!];
  return out;
}
