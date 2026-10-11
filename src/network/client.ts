// Node-to-node client: TCP → handshake → BlockFetch of a single point.
import { lookup } from "node:dns/promises";
import { isIP, Socket } from "node:net";
import { blockPoint, decodeBlock, type DecodeBlockOptions } from "../block.js";
import { CardanoBlockError } from "../errors.js";
import type { DecodedBlock } from "../types.js";
import { CLIENT_DONE, N2N_VERSIONS, parseBlockFetch, parseHandshakeReply, proposeVersions, requestRange } from "./messages.js";
import { Demuxer, encodeSegments, PROTOCOL_BLOCK_FETCH, PROTOCOL_HANDSHAKE, type MuxMessage } from "./mux.js";
import {
  isPrivateAddress,
  networkMagic,
  parsePoint,
  parseRelay,
  type NetworkName,
  type NormalizedPoint,
  type Point,
  type RelayAddress,
} from "./options.js";

export interface FetchBlockOptions {
  /** Relay as `"host:port"`, `"[ipv6]:port"` or `{ host, port }`. */
  relay: string | RelayAddress;
  /** The block to fetch: slot **and** header hash. A hash alone is rejected. */
  point: Point | string;
  /** `"mainnet"` (default), `"preprod"`, `"preview"` or a numeric network magic. */
  network?: NetworkName | number;
  /** Overall deadline for connect + handshake + fetch, in milliseconds (default 30000, max 600000). */
  timeoutMs?: number;
  /** Abort the request early. */
  signal?: AbortSignal;
  /**
   * Allow connecting to loopback, private, link-local and other non-public addresses (after DNS
   * resolution). Default `false`, so untrusted relay strings cannot reach internal services.
   * Set to `true` to talk to your own node, e.g. `127.0.0.1:3001`.
   */
  allowPrivateAddresses?: boolean | undefined;
  /** Reject blocks larger than this many bytes (default 8 MiB). */
  maxBlockBytes?: number;
  /** Node-to-node versions to propose (default `[14, 15, 16]`). */
  versions?: readonly number[];
}

export interface RawBlockResult {
  /** Block as `[eraTag, block]` CBOR (the hard-fork-combinator form, as returned by `MsgBlock`). */
  cbor: Uint8Array;
  /** Negotiated node-to-node protocol version. */
  version: number;
  /** IP address actually connected to. */
  address: string;
  /** Normalised point that was requested. */
  point: NormalizedPoint;
}

interface Validated {
  relay: RelayAddress;
  point: NormalizedPoint;
  magic: number;
  timeoutMs: number;
  maxBlockBytes: number;
  allowPrivate: boolean;
  versions: readonly number[];
}

function validate(opts: FetchBlockOptions): Validated {
  if (typeof opts !== "object" || opts === null) throw new CardanoBlockError("INVALID_ARGUMENT", "options object is required");
  const timeoutMs = opts.timeoutMs ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
    throw new CardanoBlockError("INVALID_ARGUMENT", "timeoutMs must be an integer between 1 and 600000");
  }
  const maxBlockBytes = opts.maxBlockBytes ?? 8 * 1024 * 1024;
  if (!Number.isInteger(maxBlockBytes) || maxBlockBytes < 1024 || maxBlockBytes > 256 * 1024 * 1024) {
    throw new CardanoBlockError("INVALID_ARGUMENT", "maxBlockBytes must be an integer between 1024 and 268435456");
  }
  const versions = opts.versions ?? N2N_VERSIONS;
  if (!Array.isArray(versions) || versions.length === 0 || !versions.every((v) => Number.isInteger(v) && v >= 14 && v < 0x8000)) {
    throw new CardanoBlockError("INVALID_ARGUMENT", "versions must be a non-empty list of node-to-node versions >= 14");
  }
  return {
    relay: parseRelay(opts.relay),
    point: parsePoint(opts.point),
    magic: networkMagic(opts.network),
    timeoutMs,
    maxBlockBytes,
    allowPrivate: opts.allowPrivateAddresses === true,
    versions,
  };
}

async function resolve(host: string, allowPrivate: boolean): Promise<string> {
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch (err) {
      throw new CardanoBlockError("CONNECTION", `cannot resolve relay host ${host}: ${(err as Error).message}`, { host }, { cause: err });
    }
  }
  if (allowPrivate) return addresses[0]!;
  const ok = addresses.find((a) => !isPrivateAddress(a));
  if (!ok) {
    throw new CardanoBlockError(
      "INVALID_ARGUMENT",
      `relay ${host} resolves only to non-public addresses (${addresses.join(", ")}); pass allowPrivateAddresses: true to connect to your own node`,
      { host, addresses },
    );
  }
  return ok;
}

/**
 * Connects to a relay, negotiates a node-to-node version and fetches one block with BlockFetch.
 * Returns the raw `[eraTag, block]` CBOR after verifying that its slot and hash match `point`.
 */
export async function fetchRawBlock(options: FetchBlockOptions): Promise<RawBlockResult> {
  const v = validate(options);
  const signal = options.signal;
  if (signal?.aborted) throw new CardanoBlockError("ABORTED", "aborted before start", undefined, { cause: signal.reason });
  const deadline = Date.now() + v.timeoutMs;
  const address = await withDeadline(resolve(v.relay.host, v.allowPrivate), deadline, signal, "resolving relay host");
  const result = await session(v, address, deadline, signal);
  return { ...result, address, point: v.point };
}

/** Fetches and decodes one block. See {@link fetchRawBlock} and {@link decodeBlock}. */
export async function fetchBlock(options: FetchBlockOptions & DecodeBlockOptions): Promise<DecodedBlock> {
  const raw = await fetchRawBlock(options);
  const decodeOpts: DecodeBlockOptions = {};
  if (options.includeCbor !== undefined) decodeOpts.includeCbor = options.includeCbor;
  if (options.byronSlotsPerEpoch !== undefined) decodeOpts.byronSlotsPerEpoch = options.byronSlotsPerEpoch;
  if (options.maxDepth !== undefined) decodeOpts.maxDepth = options.maxDepth;
  return decodeBlock(raw.cbor, decodeOpts);
}

function withDeadline<T>(p: Promise<T>, deadline: number, signal: AbortSignal | undefined, stage: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new CardanoBlockError("TIMEOUT", `timed out while ${stage}`, { stage })),
      Math.max(0, deadline - Date.now()),
    );
    const onAbort = (): void => reject(new CardanoBlockError("ABORTED", `aborted while ${stage}`, { stage }, { cause: signal?.reason }));
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(resolvePromise, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
  });
}

type Stage = "connecting" | "handshake" | "requesting block" | "receiving block";

function session(v: Validated, address: string, deadline: number, signal: AbortSignal | undefined): Promise<{ cbor: Uint8Array; version: number }> {
  return new Promise((resolvePromise, reject) => {
    const socket = new Socket();
    const demux = new Demuxer(v.maxBlockBytes + 64);
    let stage: Stage = "connecting";
    let version = 0;
    let block: Uint8Array | undefined;
    let settled = false;

    const finish = (err: CardanoBlockError | undefined, value?: { cbor: Uint8Array; version: number }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners("data");
      socket.on("error", () => undefined);
      if (err) socket.destroy();
      else {
        // Graceful close so MsgClientDone is flushed; force-close if the peer lingers.
        socket.end();
        setTimeout(() => socket.destroy(), 1000).unref();
      }
      if (err) reject(err);
      else resolvePromise(value!);
    };
    const timer = setTimeout(
      () => finish(new CardanoBlockError("TIMEOUT", `timed out while ${stage} (${v.relay.host}:${v.relay.port})`, { stage })),
      Math.max(0, deadline - Date.now()),
    );
    const onAbort = (): void => finish(new CardanoBlockError("ABORTED", `aborted while ${stage}`, { stage }, { cause: signal?.reason }));
    signal?.addEventListener("abort", onAbort, { once: true });

    const send = (protocol: number, payload: Uint8Array): void => {
      socket.write(encodeSegments(protocol, payload));
    };

    const onMessage = (m: MuxMessage): void => {
      if (m.protocol === PROTOCOL_HANDSHAKE) {
        if (stage !== "handshake") throw new CardanoBlockError("PROTOCOL", "unexpected handshake message");
        const r = parseHandshakeReply(m.item);
        if (r.type === "refuse") {
          throw new CardanoBlockError(
            "HANDSHAKE_REFUSED",
            `relay refused the handshake: ${r.reason} (proposed network magic ${v.magic}; check the network option)`,
            { ...r.details, magic: v.magic },
          );
        }
        if (!v.versions.includes(r.version)) {
          throw new CardanoBlockError("PROTOCOL", `relay accepted version ${r.version} which was not proposed`);
        }
        if (r.magic !== undefined && r.magic !== v.magic) {
          throw new CardanoBlockError("HANDSHAKE_REFUSED", `relay is on network magic ${r.magic}, expected ${v.magic}`, {
            magic: v.magic,
            relayMagic: r.magic,
          });
        }
        version = r.version;
        stage = "requesting block";
        send(PROTOCOL_BLOCK_FETCH, requestRange(v.point, v.point));
        return;
      }
      if (m.protocol === PROTOCOL_BLOCK_FETCH) {
        if (stage !== "requesting block" && stage !== "receiving block") {
          throw new CardanoBlockError("PROTOCOL", "unexpected BlockFetch message before handshake");
        }
        const msg = parseBlockFetch(m.item);
        if (msg.type === "noBlocks") {
          throw new CardanoBlockError(
            "NO_BLOCKS",
            `relay has no block at slot ${v.point.slot} with hash ${v.point.hash} (wrong slot/hash pair, wrong network, or the block was rolled back)`,
            { slot: v.point.slot.toString(), hash: v.point.hash },
          );
        }
        if (msg.type === "startBatch") {
          if (stage !== "requesting block") throw new CardanoBlockError("PROTOCOL", "duplicate MsgStartBatch");
          stage = "receiving block";
          return;
        }
        if (stage !== "receiving block") throw new CardanoBlockError("PROTOCOL", `${msg.type} before MsgStartBatch`);
        if (msg.type === "block") {
          if (block) throw new CardanoBlockError("PROTOCOL", "relay sent more than one block for a single-point range");
          if (msg.bytes.length > v.maxBlockBytes) throw new CardanoBlockError("PROTOCOL", `block exceeds maxBlockBytes (${v.maxBlockBytes})`);
          block = msg.bytes;
          return;
        }
        // batchDone
        if (!block) throw new CardanoBlockError("PROTOCOL", "MsgBatchDone without a block");
        try {
          send(PROTOCOL_BLOCK_FETCH, CLIENT_DONE);
        } catch {
          /* best effort */
        }
        verifyPoint(block, v.point);
        finish(undefined, { cbor: block, version });
        return;
      }
      // Other mini-protocols (e.g. keep-alive) are not started by us; ignore stray traffic.
    };

    socket.on("data", (chunk: Buffer) => {
      try {
        for (const m of demux.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
          onMessage(m);
          if (settled) return;
        }
      } catch (err) {
        if (err instanceof CardanoBlockError && err.code !== "CBOR_DECODE") finish(err);
        else {
          finish(
            new CardanoBlockError("PROTOCOL", `relay sent malformed data: ${(err as Error).message}`, undefined, { cause: err }),
          );
        }
      }
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      finish(
        new CardanoBlockError("CONNECTION", `connection to ${v.relay.host}:${v.relay.port} failed while ${stage}: ${err.code ?? err.message}`, {
          stage,
          code: err.code,
        }, { cause: err }),
      );
    });
    socket.on("close", () => {
      finish(new CardanoBlockError("CONNECTION", `relay closed the connection while ${stage}`, { stage }));
    });
    socket.setNoDelay(true);
    socket.connect({ host: address, port: v.relay.port }, () => {
      stage = "handshake";
      send(PROTOCOL_HANDSHAKE, proposeVersions(v.magic, v.versions));
    });
  });
}

/** Ensures the relay returned the requested block (slot and header hash). */
function verifyPoint(cbor: Uint8Array, point: NormalizedPoint): void {
  let block;
  try {
    block = blockPoint(cbor);
  } catch (err) {
    if (err instanceof CardanoBlockError) {
      throw new CardanoBlockError(err.code, `relay returned a block that cannot be decoded: ${err.message}`, err.details, { cause: err });
    }
    throw err;
  }
  if (block.hash !== point.hash || block.slot !== point.slot) {
    throw new CardanoBlockError(
      "BLOCK_MISMATCH",
      `relay returned block ${block.hash} at slot ${block.slot}, expected ${point.hash} at slot ${point.slot}`,
      { expectedHash: point.hash, expectedSlot: point.slot.toString(), hash: block.hash, slot: block.slot.toString() },
    );
  }
}
