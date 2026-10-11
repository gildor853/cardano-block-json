// Identifiers derived from raw bytes: CIP-5 bech32 ids, CIP-14 fingerprints, CIP-129 governance ids.
import { blake2b, blake2b224 } from "./blake2b.js";
import { concatBytes, fromHex, toHex } from "./bytes.js";
import { bech32Encode } from "./encoding.js";

const b = (h: string): Uint8Array => fromHex(h) ?? new Uint8Array();

export const poolId = (hashHex: string): string => bech32Encode("pool", b(hashHex));
export const keyHash = (vkey: Uint8Array): string => toHex(blake2b224(vkey));

export function assetFingerprint(policyHex: string, nameHex: string): string {
  return bech32Encode("asset", blake2b(concatBytes([b(policyHex), b(nameHex)]), 20));
}

/** CIP-129 credential id. `kind`: 0 = CC hot, 1 = CC cold, 2 = DRep. */
export function cip129(kind: 0 | 1 | 2, cred: { type: "key" | "script"; hash: string }): string {
  const hrp = kind === 0 ? "cc_hot" : kind === 1 ? "cc_cold" : "drep";
  const header = (kind << 4) | (cred.type === "key" ? 0x02 : 0x03);
  return bech32Encode(hrp, concatBytes([Uint8Array.of(header), b(cred.hash)]));
}

export function govActionId(txIdHex: string, index: number): string {
  // CIP-129: tx id followed by the index as a single byte (indices are < 256 in practice).
  const idx = index < 256 ? Uint8Array.of(index) : Uint8Array.of((index >> 8) & 0xff, index & 0xff);
  return bech32Encode("gov_action", concatBytes([b(txIdHex), idx]));
}
