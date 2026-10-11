// A minimal in-process Cardano relay that speaks just enough node-to-node (handshake +
// BlockFetch) to exercise the client over a real TCP socket.
import { createServer, type Server, type Socket } from "node:net";
import { cborItemLength, CborMap, CborTag, decodeCbor, encodeCbor, type CborEncodable, type CborItem } from "../../src/cbor.js";
import { blockPoint } from "../../src/block.js";
import { concatBytes, toHex } from "../../src/bytes.js";

export type Behaviour =
  | "ok"
  | "refuse-version"
  | "refuse-magic"
  | "accept-wrong-magic"
  | "accept-unproposed"
  | "no-blocks"
  | "wrong-block"
  | "close-after-handshake"
  | "silent"
  | "trickle"
  | "initiator-traffic"
  | "two-blocks"
  | "batch-done-without-block"
  | "garbage"
  | "query-reply"
  | "untagged-block"
  | "keepalive-noise";

export interface MockRelayOptions {
  magic: number;
  /** Blocks the relay can serve, as `[eraTag, block]` CBOR. */
  blocks: Uint8Array[];
  behaviour?: Behaviour;
  /** Versions the relay supports (default [14, 15]). */
  versions?: number[];
}

export interface MockRelay {
  port: number;
  /** Raw (CBOR-decoded) messages the client sent, per protocol. */
  received: Array<{ protocol: number; item: CborItem }>;
  /** Mux header words the client used. */
  modes: number[];
  close(): Promise<void>;
}

function sdu(protocol: number, payload: Uint8Array, responder = true): Uint8Array {
  const out = new Uint8Array(8 + payload.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0);
  v.setUint16(4, (responder ? 0x8000 : 0) | protocol);
  v.setUint16(6, payload.length);
  out.set(payload, 8);
  return out;
}

/** Splits a message into SDUs of at most `max` bytes. */
function sdus(protocol: number, payload: Uint8Array, max = 12288, responder = true): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let off = 0; off < payload.length; off += max) parts.push(sdu(protocol, payload.subarray(off, off + max), responder));
  return concatBytes(parts);
}

export async function startMockRelay(opts: MockRelayOptions): Promise<MockRelay> {
  const behaviour = opts.behaviour ?? "ok";
  const versions = opts.versions ?? [14, 15];
  const received: MockRelay["received"] = [];
  const modes: number[] = [];
  const sockets = new Set<Socket>();
  const index = new Map<string, Uint8Array>();
  for (const b of opts.blocks) {
    const p = blockPoint(b);
    index.set(`${p.slot}.${p.hash}`, b);
  }

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buf: Uint8Array = new Uint8Array(0);
    const partial = new Map<number, Uint8Array>();
    const write = (bytes: Uint8Array): void => {
      if (behaviour === "trickle") {
        // One TCP write per byte, block split into small SDUs.
        for (const b of bytes) socket.write(Uint8Array.of(b));
      } else socket.write(bytes);
    };
    const reply = (protocol: number, value: CborEncodable | Uint8Array, raw = false): void => {
      const payload = raw ? (value as Uint8Array) : encodeCbor(value as CborEncodable);
      write(sdus(protocol, payload, behaviour === "trickle" ? 100 : 12288));
    };

    const onMessage = (protocol: number, item: CborItem): void => {
      received.push({ protocol, item });
      if (behaviour === "silent") return;
      if (protocol === 0) {
        const table = (item as CborItem[])[1] as CborMap;
        const proposed = table.entries.map(([k]) => Number(k as bigint));
        const data = table.entries[0]![1] as CborItem[];
        const magic = Number(data[0] as bigint);
        if (behaviour === "garbage") {
          socket.write(sdu(0, Uint8Array.of(0xff, 0xff)));
          return;
        }
        if (behaviour === "query-reply") return reply(0, [3, new Map()]);
        if (behaviour === "refuse-version") return reply(0, [2, [0, [99, 100]]]);
        if (behaviour === "refuse-magic" || magic !== opts.magic) {
          return reply(0, [2, [2, Math.max(...proposed), "version data mismatch: NodeToNodeVersionData {networkMagic = NetworkMagic {unNetworkMagic = 1}}"]]);
        }
        const common = proposed.filter((v) => versions.includes(v));
        if (common.length === 0) return reply(0, [2, [0, versions]]);
        const v = behaviour === "accept-unproposed" ? 99 : Math.max(...common);
        const m = behaviour === "accept-wrong-magic" ? opts.magic + 1 : opts.magic;
        reply(0, [1, v, v >= 16 ? [m, false, 0, false, false] : [m, false, 0, false]]);
        if (behaviour === "close-after-handshake") setTimeout(() => socket.destroy(), 5);
        if (behaviour === "initiator-traffic") socket.write(sdu(2, encodeCbor([0]), false));
        if (behaviour === "keepalive-noise") socket.write(sdu(8, encodeCbor([1, 42]), true));
        return;
      }
      if (protocol === 3) {
        const msg = item as CborItem[];
        if (msg[0] === 1n) return; // MsgClientDone
        const from = msg[1] as CborItem[];
        const key = `${from[0] as bigint}.${toHex(from[1] as Uint8Array)}`;
        let block = index.get(key);
        if (behaviour === "wrong-block") block = [...index.values()].find((b) => b !== index.get(key));
        if (behaviour === "no-blocks" || !block) return reply(3, [3]);
        if (behaviour === "batch-done-without-block") {
          reply(3, [2]);
          return reply(3, [5]);
        }
        reply(3, [2]);
        const blockMsg = (b: Uint8Array): Uint8Array =>
          behaviour === "untagged-block" ? encodeCbor([4, b]) : concatBytes([Uint8Array.of(0x82, 0x04, 0xd8, 0x18), encodeCbor(b)]);
        reply(3, blockMsg(block), true);
        if (behaviour === "two-blocks") reply(3, blockMsg(block), true);
        reply(3, [5]);
      }
    };

    socket.on("data", (chunk: Buffer) => {
      buf = concatBytes([buf, new Uint8Array(chunk)]);
      while (buf.length >= 8) {
        const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const word = v.getUint16(4);
        const len = v.getUint16(6);
        if (buf.length < 8 + len) break;
        modes.push(word);
        const protocol = word & 0x7fff;
        const payload = buf.subarray(8, 8 + len);
        buf = buf.subarray(8 + len);
        let p = concatBytes([partial.get(protocol) ?? new Uint8Array(0), payload]);
        for (;;) {
          const n = p.length ? cborItemLength(p) : undefined;
          if (n === undefined) break;
          onMessage(protocol, decodeCbor(p.subarray(0, n)));
          p = p.subarray(n);
        }
        partial.set(protocol, p);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    received,
    modes,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

export { CborTag };
