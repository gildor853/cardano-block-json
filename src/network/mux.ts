// Ouroboros network multiplexer framing (SDU = 8-byte header + payload) and per-protocol
// reassembly of CBOR messages that may span several SDUs.
import { cborItemLength, decodeCborDocument, type CborItem } from "../cbor.js";
import { concatBytes } from "../bytes.js";
import { CardanoBlockError } from "../errors.js";

export const PROTOCOL_HANDSHAKE = 0;
export const PROTOCOL_CHAIN_SYNC = 2;
export const PROTOCOL_BLOCK_FETCH = 3;
export const PROTOCOL_KEEP_ALIVE = 8;

/** Maximum SDU payload we send (the socket bearer limit used by cardano-node). */
export const MAX_SDU_PAYLOAD = 12288;
const RESPONDER_BIT = 0x8000;

/** Encodes one message as one or more SDUs sent in initiator mode. */
export function encodeSegments(protocol: number, payload: Uint8Array, now: () => number = defaultClock): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let off = 0; off === 0 || off < payload.length; off += MAX_SDU_PAYLOAD) {
    const chunk = payload.subarray(off, Math.min(off + MAX_SDU_PAYLOAD, payload.length));
    const sdu = new Uint8Array(8 + chunk.length);
    const view = new DataView(sdu.buffer);
    view.setUint32(0, now() >>> 0);
    view.setUint16(4, protocol & 0x7fff);
    view.setUint16(6, chunk.length);
    sdu.set(chunk, 8);
    parts.push(sdu);
    if (payload.length === 0) break;
  }
  return concatBytes(parts);
}

function defaultClock(): number {
  // Lower 32 bits of a microsecond monotonic clock, as in the reference implementation.
  return Math.floor(performance.now() * 1000) % 0x100000000;
}

export interface MuxMessage {
  protocol: number;
  item: CborItem;
  /** Exact bytes of the message. */
  bytes: Uint8Array;
}

/**
 * Incremental demultiplexer. Feed it raw socket data; it yields complete CBOR messages per
 * mini-protocol. Only responder-side traffic (mode bit set) is accepted: since we connect in
 * initiator-only mode, the peer never runs its own initiator protocols on this connection.
 */
export class Demuxer {
  private buffer: Uint8Array = new Uint8Array(0);
  private readonly partial = new Map<number, Uint8Array>();

  constructor(private readonly maxMessageBytes: number) {}

  push(chunk: Uint8Array): MuxMessage[] {
    this.buffer = this.buffer.length ? concatBytes([this.buffer, chunk]) : chunk;
    const out: MuxMessage[] = [];
    while (this.buffer.length >= 8) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const word = view.getUint16(4);
      const len = view.getUint16(6);
      if (this.buffer.length < 8 + len) break;
      const payload = this.buffer.subarray(8, 8 + len);
      this.buffer = this.buffer.subarray(8 + len);
      if ((word & RESPONDER_BIT) === 0) {
        throw new CardanoBlockError("PROTOCOL", `relay sent initiator-mode traffic on mini-protocol ${word & 0x7fff}`, {
          protocol: word & 0x7fff,
        });
      }
      const protocol = word & 0x7fff;
      const prev = this.partial.get(protocol);
      let buf = prev ? concatBytes([prev, payload]) : payload;
      if (buf.length > this.maxMessageBytes) {
        throw new CardanoBlockError("PROTOCOL", `message on mini-protocol ${protocol} exceeds ${this.maxMessageBytes} bytes`, {
          protocol,
        });
      }
      for (;;) {
        if (buf.length === 0) break;
        const n = cborItemLength(buf);
        if (n === undefined) break;
        const bytes = buf.slice(0, n);
        out.push({ protocol, item: decodeCborDocument(bytes).root, bytes });
        buf = buf.subarray(n);
      }
      if (buf.length) this.partial.set(protocol, buf.slice());
      else this.partial.delete(protocol);
    }
    return out;
  }
}
