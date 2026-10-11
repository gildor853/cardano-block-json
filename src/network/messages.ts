// Handshake (node-to-node v14+) and BlockFetch message codecs.
import { CborTag, encodeCbor, type CborItem } from "../cbor.js";
import { fromHex } from "../bytes.js";
import { CardanoBlockError } from "../errors.js";
import type { NormalizedPoint } from "./options.js";

/** Node-to-node versions we propose (v14 and v15 share the 4-field version data, v16 adds `perasSupport`). */
export const N2N_VERSIONS: readonly number[] = [14, 15, 16];

export function proposeVersions(magic: number, versions: readonly number[] = N2N_VERSIONS): Uint8Array {
  const table = new Map<number, (number | boolean)[]>();
  // Keys in ascending order; initiator-only diffusion mode, no peer sharing, not a query.
  for (const v of [...versions].sort((a, b) => a - b)) {
    table.set(v, v >= 16 ? [magic, true, 0, false, false] : [magic, true, 0, false]);
  }
  return encodeCbor([0, table]);
}

export type HandshakeResult =
  | { type: "accept"; version: number; magic: number | undefined }
  | { type: "refuse"; reason: string; details: Record<string, unknown> };

const asNum = (x: CborItem): number | undefined => (typeof x === "bigint" ? Number(x) : undefined);

export function parseHandshakeReply(item: CborItem): HandshakeResult {
  if (!Array.isArray(item) || typeof item[0] !== "bigint") {
    throw new CardanoBlockError("PROTOCOL", "malformed handshake reply");
  }
  const tag = Number(item[0]);
  if (tag === 1) {
    const version = asNum(item[1]);
    if (version === undefined) throw new CardanoBlockError("PROTOCOL", "malformed MsgAcceptVersion");
    const data = item[2];
    const magic = Array.isArray(data) ? asNum(data[0]) : undefined;
    return { type: "accept", version, magic };
  }
  if (tag === 2) {
    const r = item[1];
    if (Array.isArray(r) && typeof r[0] === "bigint") {
      const kind = Number(r[0]);
      if (kind === 0) {
        const versions = Array.isArray(r[1]) ? r[1].map(asNum).filter((x): x is number => x !== undefined) : [];
        return {
          type: "refuse",
          reason: `version mismatch: relay supports node-to-node versions [${versions.join(", ")}]`,
          details: { kind: "VersionMismatch", versions },
        };
      }
      const version = asNum(r[1]);
      const message = typeof r[2] === "string" ? r[2] : "";
      const kindName = kind === 1 ? "HandshakeDecodeError" : "Refused";
      return { type: "refuse", reason: `${kindName} (version ${version}): ${message}`, details: { kind: kindName, version, message } };
    }
    return { type: "refuse", reason: "refused", details: {} };
  }
  if (tag === 3) throw new CardanoBlockError("PROTOCOL", "relay answered with MsgQueryReply although no query was requested");
  if (tag === 0) throw new CardanoBlockError("PROTOCOL", "relay sent MsgProposeVersions (simultaneous open is not supported)");
  throw new CardanoBlockError("PROTOCOL", `unknown handshake message ${tag}`);
}

export function requestRange(from: NormalizedPoint, to: NormalizedPoint): Uint8Array {
  const pt = (p: NormalizedPoint) => [p.slot, fromHex(p.hash)!];
  return encodeCbor([0, pt(from), pt(to)]);
}

export const CLIENT_DONE = encodeCbor([1]);

export type BlockFetchMessage =
  | { type: "startBatch" }
  | { type: "noBlocks" }
  | { type: "block"; bytes: Uint8Array }
  | { type: "batchDone" };

export function parseBlockFetch(item: CborItem): BlockFetchMessage {
  if (!Array.isArray(item) || typeof item[0] !== "bigint") throw new CardanoBlockError("PROTOCOL", "malformed BlockFetch message");
  switch (Number(item[0])) {
    case 2:
      return { type: "startBatch" };
    case 3:
      return { type: "noBlocks" };
    case 4: {
      const b = item[1];
      // The block travels wrapped in CBOR-in-CBOR (tag 24).
      if (b instanceof CborTag && b.tag === 24n && b.value instanceof Uint8Array) return { type: "block", bytes: b.value };
      if (b instanceof Uint8Array) return { type: "block", bytes: b };
      throw new CardanoBlockError("PROTOCOL", "MsgBlock payload is not a tag-24 byte string");
    }
    case 5:
      return { type: "batchDone" };
    default:
      throw new CardanoBlockError("PROTOCOL", `unexpected BlockFetch message ${item[0]}`);
  }
}

