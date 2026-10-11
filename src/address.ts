// Cardano address decoding (CIP-19 Shelley addresses, Byron bootstrap addresses as base58).
import { toHex } from "./bytes.js";
import { base58Encode, bech32Encode } from "./encoding.js";
import type { Address, Credential } from "./types.js";

function readNat(bytes: Uint8Array, at: number): [bigint, number] | undefined {
  let n = 0n;
  for (let i = at; i < bytes.length && i < at + 16; i++) {
    const x = bytes[i]!;
    n = (n << 7n) | BigInt(x & 0x7f);
    if ((x & 0x80) === 0) return [n, i + 1];
  }
  return undefined;
}

const cred = (type: "key" | "script", bytes: Uint8Array): Credential => ({ type, hash: toHex(bytes) });

/**
 * Decodes raw address bytes. Never throws: malformed addresses come back with `type: "unknown"`
 * (the ledger accepted some malformed pointer addresses on mainnet).
 */
export function decodeAddress(bytes: Uint8Array): Address {
  const hex = toHex(bytes);
  if (bytes.length === 0) return { hex, type: "unknown", typeId: -1 };
  const header = bytes[0]!;
  const typeId = header >> 4;
  const networkId = header & 0x0f;
  const testnet = networkId !== 1;
  const unknown = (): Address => ({ hex, type: "unknown", typeId, networkId });
  const payment = typeId & 1 ? "script" : "key";
  const shelleyBech32 = (): string => bech32Encode(testnet ? "addr_test" : "addr", bytes);

  if (typeId <= 3) {
    if (bytes.length !== 57) return unknown();
    return {
      hex,
      bech32: shelleyBech32(),
      type: "base",
      typeId,
      networkId,
      paymentCredential: cred(payment, bytes.subarray(1, 29)),
      stakeCredential: cred(typeId & 2 ? "script" : "key", bytes.subarray(29, 57)),
    };
  }
  if (typeId === 4 || typeId === 5) {
    if (bytes.length < 30) return unknown();
    const a = readNat(bytes, 29);
    const b = a && readNat(bytes, a[1]);
    const c = b && readNat(bytes, b[1]);
    const out: Address = {
      hex,
      bech32: shelleyBech32(),
      type: "pointer",
      typeId,
      networkId,
      paymentCredential: cred(payment, bytes.subarray(1, 29)),
    };
    if (a && b && c) out.pointer = { slot: a[0], txIndex: b[0], certIndex: c[0] };
    return out;
  }
  if (typeId === 6 || typeId === 7) {
    if (bytes.length !== 29) return unknown();
    return { hex, bech32: shelleyBech32(), type: "enterprise", typeId, networkId, paymentCredential: cred(payment, bytes.subarray(1, 29)) };
  }
  if (typeId === 8) return { hex, base58: base58Encode(bytes), type: "byron", typeId };
  if (typeId === 14 || typeId === 15) {
    if (bytes.length !== 29) return unknown();
    return {
      hex,
      bech32: bech32Encode(testnet ? "stake_test" : "stake", bytes),
      type: "reward",
      typeId,
      networkId,
      stakeCredential: cred(typeId === 15 ? "script" : "key", bytes.subarray(1, 29)),
    };
  }
  return unknown();
}
