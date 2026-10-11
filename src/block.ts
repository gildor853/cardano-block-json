// Block-level decoding: HFC era wrapper, Shelley-family headers and bodies, Byron blocks.
import { decodeAddress } from "./address.js";
import { blake2b224, blake2b256 } from "./blake2b.js";
import { CborTag, decodeCborDocument, type CborItem } from "./cbor.js";
import { concatBytes, fromHex, toHex } from "./bytes.js";
import { CardanoBlockError } from "./errors.js";
import { poolId } from "./ids.js";
import { arr, bytes, type Ctx, fail, hex, map, small, uint } from "./read.js";
import { auxiliaryData, txBody, witnessSet } from "./tx.js";
import type {
  BlockHeader,
  ByronBlock,
  ByronEpochBoundaryBlock,
  ByronTransaction,
  DecodedBlock,
  Era,
  ShelleyBlock,
  ShelleyEra,
  Transaction,
  VrfCert,
} from "./types.js";

export interface DecodeBlockOptions {
  /**
   * Include raw CBOR hex of the block, each transaction body / witness set / auxiliary data.
   * Default `false`.
   */
  includeCbor?: boolean;
  /**
   * Era to assume when the input is a bare era block without the hard-fork-combinator
   * `[eraTag, block]` wrapper. By default the era is inferred from the header protocol version.
   */
  era?: Exclude<Era, "unknown">;
  /** Slots per Byron epoch used to compute absolute Byron slots (default 21600 = 10·k, k = 2160). */
  byronSlotsPerEpoch?: number;
  /** Maximum CBOR nesting depth (default 256). */
  maxDepth?: number;
}

export const ERA_TAGS: readonly Era[] = ["byron-ebb", "byron", "shelley", "allegra", "mary", "alonzo", "babbage", "conway"];

/** Converts accepted block inputs (bytes, Buffer, hex string) to a Uint8Array. */
export function toBytes(input: Uint8Array | ArrayBuffer | string, what = "block"): Uint8Array {
  if (typeof input === "string") {
    const clean = input.trim().replace(/^0x/i, "");
    const b = fromHex(clean);
    if (!b) throw new CardanoBlockError("INVALID_ARGUMENT", `${what} hex string is not valid hex`);
    return b;
  }
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new CardanoBlockError("INVALID_ARGUMENT", `${what} must be a Uint8Array, Buffer, ArrayBuffer or hex string`);
}

function eraFromProtocolMajor(major: number): ShelleyEra {
  if (major <= 2) return "shelley";
  if (major === 3) return "allegra";
  if (major === 4) return "mary";
  if (major <= 6) return "alonzo";
  if (major <= 8) return "babbage";
  return "conway";
}

/**
 * Decodes a Cardano block from CBOR. Accepts:
 * - the hard-fork-combinator form `[eraTag, block]` (what BlockFetch carries and the ImmutableDB stores),
 * - the same wrapped in CBOR tag 24 (the raw `MsgBlock` payload),
 * - a bare era block (era inferred from the header, or given via `options.era`).
 */
export function decodeBlock(input: Uint8Array | ArrayBuffer | string, options: DecodeBlockOptions = {}): DecodedBlock {
  let data = toBytes(input);
  if (data.length === 0) throw new CardanoBlockError("CBOR_DECODE", "empty input");
  const docOpts = options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {};
  let doc = decodeCborDocument(data, docOpts);
  let root = doc.root;
  if (root instanceof CborTag && root.tag === 24n && root.value instanceof Uint8Array) {
    data = root.value;
    doc = decodeCborDocument(data, docOpts);
    root = doc.root;
  }
  const ctxBase = { warnings: [] as string[], includeCbor: options.includeCbor === true };
  const top = arr(root, "block");

  // HFC wrapper: [eraTag, block]
  if (top.length === 2 && typeof top[0] === "bigint" && Array.isArray(top[1])) {
    const tag = Number(top[0]);
    const inner = top[1];
    const raw = doc.rawChild(top, 1);
    const ctx: Ctx = { doc, ...ctxBase };
    if (tag === 0) return byronEbb(ctx, inner, raw, options);
    if (tag === 1) return byronMain(ctx, inner, raw, options);
    if (tag >= 2 && tag <= 7) return shelleyBlock(ctx, inner, raw, ERA_TAGS[tag] as ShelleyEra, tag);
    if (tag > 7 && tag < 64) {
      ctx.warnings.push(`unknown era tag ${tag}; decoded with Conway rules`);
      return shelleyBlock(ctx, inner, raw, "unknown", tag);
    }
    fail("block", `unknown era tag ${tag}`);
  }

  // Bare era block.
  const ctx: Ctx = { doc, ...ctxBase };
  const raw = doc.raw(top);
  if (options.era === "byron") return byronMain(ctx, top, raw, options);
  if (options.era === "byron-ebb") return byronEbb(ctx, top, raw, options);
  if (top.length === 3 && Array.isArray(top[0]) && (top[0] as CborItem[]).length === 5 && options.era === undefined) {
    // Byron blocks are [header(5), body, extra]; decide main vs EBB by the consensus data shape.
    const consensus = (top[0] as CborItem[])[3];
    return Array.isArray(consensus) && consensus.length === 4 ? byronMain(ctx, top, raw, options) : byronEbb(ctx, top, raw, options);
  }
  let era: ShelleyEra;
  if (options.era) era = options.era;
  else {
    const header = arr(arr(top, "block", 4)[0], "block.header", 2);
    const body = arr(header[0], "block.header.body");
    const pv = body.length === 10 ? arr(body[9], "block.header.body.protocolVersion", 2)[0] : body[13];
    const major = small(pv, "block.header.body.protocolVersion.major");
    era = eraFromProtocolMajor(major);
    ctx.warnings.push(
      `era "${era}" inferred from header protocol version ${major} (blocks may signal the next era's version); pass options.era or the [eraTag, block] form for certainty`,
    );
  }
  return shelleyBlock(ctx, top, raw, era, ERA_TAGS.indexOf(era));
}

/**
 * Returns the point (slot + header hash) and era of a block without decoding its transactions.
 * Accepts the same inputs as {@link decodeBlock}.
 */
export function blockPoint(input: Uint8Array | ArrayBuffer | string, options: Pick<DecodeBlockOptions, "byronSlotsPerEpoch"> = {}): {
  slot: bigint;
  hash: string;
  era: Era;
} {
  let doc = decodeCborDocument(toBytes(input));
  if (doc.root instanceof CborTag && doc.root.tag === 24n && doc.root.value instanceof Uint8Array) doc = decodeCborDocument(doc.root.value);
  const top = arr(doc.root, "block", 2);
  if (top.length !== 2 || typeof top[0] !== "bigint" || !Array.isArray(top[1])) fail("block", "expected [eraTag, block]");
  const tag = Number(top[0]);
  const block = arr(top[1], "block", 1);
  const headerRaw = doc.rawChild(block, 0);
  const spe = BigInt(options.byronSlotsPerEpoch ?? 21600);
  if (tag === 0 || tag === 1) {
    const h = arr(block[0], "byron.header", 5);
    if (tag === 0) {
      const epoch = uint(arr(h[3], "byron-ebb.header.consensus", 2)[0], "byron-ebb.epoch");
      return { slot: epoch * spe, hash: byronHash(0, headerRaw), era: "byron-ebb" };
    }
    const slotId = arr(arr(h[3], "byron.header.consensus", 4)[0], "byron.slotId", 2);
    return { slot: uint(slotId[0], "byron.epoch") * spe + uint(slotId[1], "byron.slot"), hash: byronHash(1, headerRaw), era: "byron" };
  }
  const body = arr(arr(block[0], "header", 2)[0], "header.body", 2);
  return { slot: uint(body[1], "header.slot"), hash: toHex(blake2b256(headerRaw)), era: ERA_TAGS[tag] ?? "unknown" };
}

// ----------------------------------------------------------------------------------------------
// Shelley family (Shelley … Conway)

function vrf(item: CborItem, path: string): VrfCert {
  const a = arr(item, path, 2);
  return { output: hex(a[0], `${path}.output`), proof: hex(a[1], `${path}.proof`) };
}

function header(ctx: Ctx, item: CborItem): BlockHeader {
  const h = arr(item, "header", 2);
  const b = arr(h[0], "header.body");
  if (b.length !== 10 && b.length !== 15) fail("header.body", `expected 10 (Praos) or 15 (TPraos) fields, got ${b.length}`);
  const issuer = bytes(b[3], "header.issuerVkey", 32);
  const issuerPoolHash = toHex(blake2b224(issuer));
  const common = {
    blockNumber: uint(b[0], "header.blockNumber"),
    slot: uint(b[1], "header.slot"),
    prevHash: b[2] === null ? null : hex(b[2], "header.prevHash", 32),
    issuerVkey: toHex(issuer),
    issuerPoolHash,
    issuerPoolId: poolId(issuerPoolHash),
    vrfVkey: hex(b[4], "header.vrfVkey", 32),
  };
  const kesSignature = hex(h[1], "header.kesSignature");
  const size = ctx.doc.raw(h).length;
  if (b.length === 10) {
    // Praos (Babbage, Conway)
    const oc = arr(b[8], "header.operationalCert", 4);
    const pv = arr(b[9], "header.protocolVersion", 2);
    return {
      ...common,
      vrfResult: vrf(b[5], "header.vrfResult"),
      bodySize: small(b[6], "header.bodySize"),
      bodyHash: hex(b[7], "header.bodyHash", 32),
      operationalCert: {
        hotVkey: hex(oc[0], "header.operationalCert.hotVkey"),
        sequenceNumber: uint(oc[1], "header.operationalCert.sequenceNumber"),
        kesPeriod: uint(oc[2], "header.operationalCert.kesPeriod"),
        sigma: hex(oc[3], "header.operationalCert.sigma"),
      },
      protocolVersion: { major: small(pv[0], "header.protocolVersion.major"), minor: small(pv[1], "header.protocolVersion.minor") },
      kesSignature,
      size,
    };
  }
  if (b.length === 15) {
    // TPraos (Shelley … Alonzo)
    return {
      ...common,
      nonceVrf: vrf(b[5], "header.nonceVrf"),
      leaderVrf: vrf(b[6], "header.leaderVrf"),
      bodySize: small(b[7], "header.bodySize"),
      bodyHash: hex(b[8], "header.bodyHash", 32),
      operationalCert: {
        hotVkey: hex(b[9], "header.operationalCert.hotVkey"),
        sequenceNumber: uint(b[10], "header.operationalCert.sequenceNumber"),
        kesPeriod: uint(b[11], "header.operationalCert.kesPeriod"),
        sigma: hex(b[12], "header.operationalCert.sigma"),
      },
      protocolVersion: { major: small(b[13], "header.protocolVersion.major"), minor: small(b[14], "header.protocolVersion.minor") },
      kesSignature,
      size,
    };
  }
  return fail("header.body", `expected 10 (Praos) or 15 (TPraos) fields, got ${b.length}`);
}

function shelleyBlock(ctx: Ctx, block: CborItem[], raw: Uint8Array, era: ShelleyEra, eraTag: number): ShelleyBlock {
  const doc = ctx.doc;
  const alonzoPlus = block.length >= 5;
  if (block.length !== 4 && block.length !== 5) fail("block", `expected 4 or 5 elements, got ${block.length}`);
  const hdr = header(ctx, block[0]);
  const hash = toHex(blake2b256(doc.rawChild(block, 0)));

  const bodies = arr(block[1], "block.transactionBodies");
  const witnesses = arr(block[2], "block.transactionWitnessSets");
  const auxMap = map(block[3], "block.auxiliaryData");
  const invalid = alonzoPlus ? arr(block[4], "block.invalidTransactions").map((x, i) => small(x, `block.invalidTransactions[${i}]`)) : [];
  if (bodies.length !== witnesses.length) {
    fail("block", `${bodies.length} transaction bodies but ${witnesses.length} witness sets`);
  }

  // Integrity: body hash = H( H(bodies) || H(witnesses) || H(aux) [|| H(invalid)] ).
  const segments = [1, 2, 3, ...(alonzoPlus ? [4] : [])].map((i) => doc.rawChild(block, i));
  const computedBodyHash = toHex(blake2b256(concatBytes(segments.map((s) => blake2b256(s)))));
  const computedBodySize = segments.reduce((n, s) => n + s.length, 0);

  const auxByIndex = new Map<number, number>();
  auxMap.entries.forEach(([k], i) => auxByIndex.set(small(k, `block.auxiliaryData[${i}].key`), i));
  for (const idx of auxByIndex.keys()) {
    if (idx >= bodies.length) ctx.warnings.push(`auxiliary data for non-existent transaction ${idx}`);
  }
  const invalidSet = new Set(invalid);
  for (const idx of invalid) {
    if (idx >= bodies.length) ctx.warnings.push(`invalid transaction index ${idx} out of range`);
  }

  let auxHashesValid = true;
  const transactions: Transaction[] = bodies.map((bodyItem, index) => {
    const path = `transactions[${index}]`;
    const bodyRaw = doc.rawChild(bodies, index);
    const witRaw = doc.rawChild(witnesses, index);
    const body = txBody(ctx, bodyItem, `${path}.body`);
    const auxSlot = auxByIndex.get(index);
    const auxRaw = auxSlot === undefined ? undefined : doc.rawMapValue(auxMap, auxSlot);
    const tx: Transaction = {
      index,
      id: toHex(blake2b256(bodyRaw)),
      valid: !invalidSet.has(index),
      // Ledger size used for fees: [body, witnesses, auxiliaryData / null] (Alonzo+ excludes the isValid flag).
      size: 1 + bodyRaw.length + witRaw.length + (auxRaw ? auxRaw.length : 1),
      ...body,
      witnesses: witnessSet(ctx, witnesses[index], `${path}.witnesses`),
    };
    if (auxSlot !== undefined && auxRaw) {
      tx.auxiliaryData = auxiliaryData(ctx, auxMap.entries[auxSlot]![1], auxRaw, `${path}.auxiliaryData`);
      if (tx.auxiliaryDataHash !== tx.auxiliaryData.hash) auxHashesValid = false;
    } else if (tx.auxiliaryDataHash !== undefined) auxHashesValid = false;
    if (ctx.includeCbor) {
      tx.cbor = { body: toHex(bodyRaw), witnesses: toHex(witRaw), ...(auxRaw ? { auxiliaryData: toHex(auxRaw) } : {}) };
    }
    return tx;
  });

  const out: ShelleyBlock = {
    era,
    eraTag,
    hash,
    slot: hdr.slot,
    blockNumber: hdr.blockNumber,
    size: raw.length,
    header: hdr,
    transactions,
    invalidTransactions: invalid,
    stats: {
      transactionCount: transactions.length,
      invalidTransactionCount: transactions.filter((t) => !t.valid).length,
      totalFees: transactions.reduce((s, t) => s + (t.valid ? t.fee : 0n), 0n),
      totalOutputLovelace: transactions.reduce((s, t) => s + (t.valid ? t.outputLovelace : 0n), 0n),
      totalTxSize: transactions.reduce((s, t) => s + t.size, 0),
    },
    integrity: {
      bodyHashValid: computedBodyHash === hdr.bodyHash,
      computedBodyHash,
      bodySizeValid: computedBodySize === hdr.bodySize,
      computedBodySize,
      auxiliaryDataHashesValid: auxHashesValid,
    },
    warnings: ctx.warnings,
  };
  if (ctx.includeCbor) out.cbor = toHex(raw);
  return out;
}

// ----------------------------------------------------------------------------------------------
// Byron (best effort)

function byronHash(kind: 0 | 1, headerRaw: Uint8Array): string {
  // Byron header hashes cover the header wrapped as [kind, header].
  return toHex(blake2b256(concatBytes([Uint8Array.of(0x82, kind), headerRaw])));
}

function tag24Inner(ctx: Ctx, item: CborItem, path: string): CborItem {
  if (!(item instanceof CborTag) || item.tag !== 24n) fail(path, "expected CBOR tag 24");
  return decodeCborDocument(bytes(item.value, path)).root;
}

function byronAddressBytes(ctx: Ctx, item: CborItem, path: string): Uint8Array {
  // Byron address = [#6.24(bytes), crc32]; the whole array is the address.
  arr(item, path, 2);
  return ctx.doc.raw(item);
}

function byronMain(ctx: Ctx, block: CborItem[], raw: Uint8Array, options: DecodeBlockOptions): ByronBlock {
  const doc = ctx.doc;
  const h = arr(block[0], "byron.header", 5);
  const headerRaw = doc.rawChild(block, 0);
  const consensus = arr(h[3], "byron.header.consensus", 4);
  const slotId = arr(consensus[0], "byron.header.consensus.slotId", 2);
  const epoch = uint(slotId[0], "byron.epoch");
  const slotInEpoch = uint(slotId[1], "byron.slot");
  const spe = BigInt(options.byronSlotsPerEpoch ?? 21600);
  const difficulty = arr(consensus[2], "byron.header.consensus.difficulty", 1);
  const extra = arr(h[4], "byron.header.extraData");
  let protocolVersion: ByronBlock["header"]["protocolVersion"] = null;
  let softwareVersion: ByronBlock["header"]["softwareVersion"] = null;
  try {
    const pv = arr(extra[0], "pv", 3);
    protocolVersion = { major: small(pv[0], "pv"), minor: small(pv[1], "pv"), alt: small(pv[2], "pv") };
    const sv = arr(extra[1], "sv", 2);
    softwareVersion = { name: String(sv[0]), version: small(sv[1], "sv") };
  } catch {
    ctx.warnings.push("byron.header.extraData: unexpected layout");
  }

  const body = arr(block[1], "byron.body", 4);
  const txPayload = arr(body[0], "byron.body.txPayload");
  const transactions: ByronTransaction[] = txPayload.map((entry, index) => {
    const path = `transactions[${index}]`;
    const e = arr(entry, path, 2);
    const tx = arr(e[0], `${path}.tx`, 3);
    const txRaw = doc.rawChild(e, 0);
    const ins = arr(tx[0], `${path}.inputs`).map((inp, j) => {
      const a = arr(inp, `${path}.inputs[${j}]`, 2);
      const type = small(a[0], `${path}.inputs[${j}].type`);
      if (type !== 0) return { type, txId: "", index: -1 };
      const inner = arr(tag24Inner(ctx, a[1], `${path}.inputs[${j}]`), `${path}.inputs[${j}]`, 2);
      return { type, txId: hex(inner[0], `${path}.inputs[${j}].txId`, 32), index: small(inner[1], `${path}.inputs[${j}].index`) };
    });
    const outs = arr(tx[1], `${path}.outputs`).map((o, j) => {
      const a = arr(o, `${path}.outputs[${j}]`, 2);
      return {
        index: j,
        address: decodeAddress(byronAddressBytes(ctx, a[0], `${path}.outputs[${j}].address`)),
        lovelace: uint(a[1], `${path}.outputs[${j}].amount`),
      };
    });
    const wits = arr(e[1], `${path}.witnesses`).map((w, j) => {
      const a = arr(w, `${path}.witnesses[${j}]`, 2);
      const typeId = small(a[0], `${path}.witnesses[${j}].type`);
      const type = (["pk", "script", "redeem"] as const)[typeId] ?? "unknown";
      const out: ByronTransaction["witnesses"][number] = { type, typeId, cbor: toHex(doc.rawChild(a, 1)) };
      if (typeId === 0 || typeId === 2) {
        try {
          const inner = arr(tag24Inner(ctx, a[1], `${path}.witnesses[${j}]`), `${path}.witnesses[${j}]`, 2);
          out.vkey = hex(inner[0], "vkey");
          out.signature = hex(inner[1], "signature");
        } catch {
          ctx.warnings.push(`${path}.witnesses[${j}]: unexpected witness layout`);
        }
      }
      return out;
    });
    const t: ByronTransaction = {
      index,
      id: toHex(blake2b256(txRaw)),
      size: txRaw.length,
      inputs: ins,
      outputs: outs,
      outputLovelace: outs.reduce((s, o) => s + o.lovelace, 0n),
      attributes: toHex(doc.rawChild(tx, 2)),
      witnesses: wits,
    };
    if (ctx.includeCbor) t.cbor = toHex(txRaw);
    return t;
  });

  const out: ByronBlock = {
    era: "byron",
    eraTag: 1,
    hash: byronHash(1, headerRaw),
    slot: epoch * spe + slotInEpoch,
    epoch,
    slotInEpoch,
    blockNumber: uint(difficulty[0], "byron.difficulty"),
    size: raw.length,
    header: {
      protocolMagic: small(h[0], "byron.header.protocolMagic"),
      prevHash: hex(h[1], "byron.header.prevHash", 32),
      issuerVkey: hex(consensus[1], "byron.header.issuerVkey"),
      bodyProof: toHex(doc.rawChild(h, 2)),
      signature: toHex(doc.rawChild(consensus, 3)),
      protocolVersion,
      softwareVersion,
      size: headerRaw.length,
    },
    transactions,
    payloads: { ssc: toHex(doc.rawChild(body, 1)), delegation: toHex(doc.rawChild(body, 2)), update: toHex(doc.rawChild(body, 3)) },
    stats: {
      transactionCount: transactions.length,
      totalOutputLovelace: transactions.reduce((s, t) => s + t.outputLovelace, 0n),
      totalTxSize: transactions.reduce((s, t) => s + t.size, 0),
    },
    warnings: ctx.warnings,
  };
  if (ctx.includeCbor) out.cbor = toHex(raw);
  return out;
}

function byronEbb(ctx: Ctx, block: CborItem[], raw: Uint8Array, options: DecodeBlockOptions): ByronEpochBoundaryBlock {
  const doc = ctx.doc;
  const h = arr(block[0], "byron-ebb.header", 4);
  const headerRaw = doc.rawChild(block, 0);
  const consensus = arr(h[3], "byron-ebb.header.consensus", 2);
  const epoch = uint(consensus[0], "byron-ebb.epoch");
  const difficulty = arr(consensus[1], "byron-ebb.difficulty", 1);
  const spe = BigInt(options.byronSlotsPerEpoch ?? 21600);
  const out: ByronEpochBoundaryBlock = {
    era: "byron-ebb",
    eraTag: 0,
    hash: byronHash(0, headerRaw),
    slot: epoch * spe,
    epoch,
    blockNumber: uint(difficulty[0], "byron-ebb.difficulty"),
    size: raw.length,
    header: {
      protocolMagic: small(h[0], "byron-ebb.header.protocolMagic"),
      prevHash: hex(h[1], "byron-ebb.header.prevHash", 32),
      bodyProof: toHex(doc.rawChild(h, 2)),
      size: headerRaw.length,
    },
    stakeholders: arr(block[1], "byron-ebb.body").map((s, i) => hex(s, `byron-ebb.body[${i}]`)),
    transactions: [],
    warnings: ctx.warnings,
  };
  if (ctx.includeCbor) out.cbor = toHex(raw);
  return out;
}

/**
 * Narrows a decoded block to a Shelley-based block (Shelley … Conway), which has
 * `stats`, `integrity`, `invalidTransactions` and ledger-era transactions.
 */
export function isShelleyBlock(block: DecodedBlock): block is ShelleyBlock {
  return block.era !== "byron" && block.era !== "byron-ebb";
}
