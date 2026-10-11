// Shelley-family transaction decoding: bodies, outputs, certificates, governance, witnesses,
// auxiliary data.
import { decodeAddress } from "./address.js";
import { blake2b224, blake2b256 } from "./blake2b.js";
import { CborMap, CborTag, decodeCborDocument, type CborItem } from "./cbor.js";
import { concatBytes, toHex, utf8OrUndefined } from "./bytes.js";
import { assetFingerprint, cip129, govActionId, keyHash, poolId } from "./ids.js";
import { metadatum, plutusData } from "./plutus.js";
import {
  arr,
  bool,
  bytes,
  type Ctx,
  fail,
  hex,
  int,
  intKeyed,
  map,
  nullable,
  rational,
  rawHex,
  set,
  small,
  text,
  uint,
  unwrapSet,
} from "./read.js";
import type {
  Address,
  Anchor,
  Asset,
  AuxiliaryData,
  Certificate,
  Credential,
  Datum,
  DRep,
  GovAction,
  GovActionId,
  NativeScript,
  ProposalProcedure,
  ProtocolParamUpdate,
  Redeemer,
  RedeemerTag,
  Relay,
  Script,
  TxInput,
  TxOutput,
  Update,
  Value,
  Voter,
  VoterRole,
  VotingProcedures,
  Withdrawal,
  Witnesses,
} from "./types.js";

// ----------------------------------------------------------------------------------------------
// Small structures

export function credential(item: CborItem, path: string): Credential {
  const a = arr(item, path, 2);
  const t = small(a[0], `${path}[0]`);
  if (t !== 0 && t !== 1) fail(path, `unknown credential type ${t}`);
  return { type: t === 0 ? "key" : "script", hash: hex(a[1], `${path}[1]`, 28) };
}

function txInput(item: CborItem, path: string): TxInput {
  const a = arr(item, path, 2);
  return { txId: hex(a[0], `${path}.txId`, 32), index: small(a[1], `${path}.index`) };
}

const inputs = (item: CborItem, path: string): TxInput[] => set(item, path).map((x, i) => txInput(x, `${path}[${i}]`));

function anchor(item: CborItem, path: string): Anchor {
  const a = arr(item, path, 2);
  return { url: text(a[0], `${path}.url`), dataHash: hex(a[1], `${path}.dataHash`) };
}

function assetNameUtf8(name: Uint8Array): string | undefined {
  if (name.length === 0) return undefined;
  const s = utf8OrUndefined(name);
  // Only report names made of printable characters (no control chars).
  return s !== undefined && !/[\u0000-\u001f\u007f-\u009f]/.test(s) ? s : undefined;
}

function multiAsset(item: CborItem, path: string): Asset[] {
  const out: Asset[] = [];
  for (const [p, assets] of map(item, path).entries) {
    const policyId = hex(p, `${path}.policy`, 28);
    for (const [n, q] of map(assets, `${path}.${policyId}`).entries) {
      const nameBytes = bytes(n, `${path}.${policyId}.name`);
      const assetName = toHex(nameBytes);
      const a: Asset = {
        policyId,
        assetName,
        fingerprint: assetFingerprint(policyId, assetName),
        quantity: int(q, `${path}.${policyId}.${assetName}`),
      };
      const utf8 = assetNameUtf8(nameBytes);
      if (utf8 !== undefined) a.assetNameUtf8 = utf8;
      out.push(a);
    }
  }
  return out;
}

function value(item: CborItem, path: string): Value {
  if (Array.isArray(item)) {
    const a = arr(item, path, 2);
    return { lovelace: uint(a[0], `${path}.coin`), assets: multiAsset(a[1], `${path}.assets`) };
  }
  return { lovelace: uint(item, path), assets: [] };
}

const address = (item: CborItem, path: string): Address => decodeAddress(bytes(item, path));

// ----------------------------------------------------------------------------------------------
// Scripts, datums

function nativeScript(item: CborItem, path: string): NativeScript {
  const a = arr(item, path, 1);
  const t = small(a[0], `${path}[0]`);
  const list = (x: CborItem, p: string): NativeScript[] => set(x, p).map((s, i) => nativeScript(s, `${p}[${i}]`));
  switch (t) {
    case 0:
      return { type: "sig", keyHash: hex(arr(item, path, 2)[1], `${path}.keyHash`, 28) };
    case 1:
      return { type: "all", scripts: list(arr(item, path, 2)[1], `${path}.scripts`) };
    case 2:
      return { type: "any", scripts: list(arr(item, path, 2)[1], `${path}.scripts`) };
    case 3: {
      const b = arr(item, path, 3);
      return { type: "atLeast", required: uint(b[1], `${path}.required`), scripts: list(b[2], `${path}.scripts`) };
    }
    case 4:
      return { type: "after", slot: uint(arr(item, path, 2)[1], `${path}.slot`) };
    case 5:
      return { type: "before", slot: uint(arr(item, path, 2)[1], `${path}.slot`) };
    default:
      return fail(path, `unknown native script type ${t}`);
  }
}

function scriptHash(prefix: number, body: Uint8Array): string {
  return toHex(blake2b224(concatBytes([Uint8Array.of(prefix), body])));
}

export function nativeScriptEntry(ctx: Ctx, rawCbor: Uint8Array, item: CborItem, path: string): Script {
  return { language: "native", hash: scriptHash(0, rawCbor), size: rawCbor.length, cbor: toHex(rawCbor), script: nativeScript(item, path) };
}

const PLUTUS = ["plutusV1", "plutusV2", "plutusV3"] as const;

function plutusScriptEntry(version: 1 | 2 | 3, script: Uint8Array): Script {
  return { language: PLUTUS[version - 1]!, hash: scriptHash(version, script), size: script.length, cbor: toHex(script) };
}

/** script_ref: #6.24(bytes .cbor [0, native] / [1, v1] / [2, v2] / [3, v3]). */
function scriptRef(ctx: Ctx, item: CborItem, path: string): Script {
  if (!(item instanceof CborTag) || item.tag !== 24n) fail(path, "script_ref must be tag 24");
  const inner = bytes(item.value, path);
  const doc = decodeCborDocument(inner);
  const a = arr(doc.root, path, 2);
  const lang = small(a[0], `${path}[0]`);
  if (lang === 0) {
    const rawScript = doc.rawChild(a, 1);
    return nativeScriptEntry({ ...ctx, doc }, rawScript, a[1], `${path}.native`);
  }
  if (lang >= 1 && lang <= 3) return plutusScriptEntry(lang as 1 | 2 | 3, bytes(a[1], `${path}.script`));
  ctx.warnings.push(`${path}: unknown script language ${lang}`);
  return { language: "unknown", languageId: lang, cbor: toHex(inner) };
}

function datum(rawCbor: Uint8Array, item: CborItem, path: string): Datum {
  return { hash: toHex(blake2b256(rawCbor)), cbor: toHex(rawCbor), json: plutusData(item, path) };
}

// ----------------------------------------------------------------------------------------------
// Outputs

function txOutput(ctx: Ctx, item: CborItem, index: number, path: string): TxOutput {
  if (Array.isArray(item)) {
    const a = arr(item, path, 2);
    const out: TxOutput = { index, address: address(a[0], `${path}.address`), value: value(a[1], `${path}.value`), format: "legacy" };
    if (a.length > 2 && a[2] !== null) out.datumHash = hex(a[2], `${path}.datumHash`, 32);
    return out;
  }
  const m = map(item, path);
  const addr = m.get(0);
  const val = m.get(1);
  if (addr === undefined || val === undefined) fail(path, "output map requires keys 0 (address) and 1 (value)");
  const out: TxOutput = { index, address: address(addr, `${path}.address`), value: value(val, `${path}.value`), format: "map" };
  const d = m.get(2);
  if (d !== undefined) {
    const da = arr(d, `${path}.datum`, 2);
    const kind = small(da[0], `${path}.datum[0]`);
    if (kind === 0) out.datumHash = hex(da[1], `${path}.datumHash`, 32);
    else if (kind === 1) {
      const tagged = da[1];
      if (!(tagged instanceof CborTag) || tagged.tag !== 24n) fail(`${path}.datum`, "inline datum must be tag 24");
      const raw = bytes(tagged.value, `${path}.datum`);
      out.inlineDatum = datum(raw, decodeCborDocument(raw).root, `${path}.inlineDatum`);
    } else fail(`${path}.datum`, `unknown datum option ${kind}`);
  }
  const sr = m.get(3);
  if (sr !== undefined) out.scriptRef = scriptRef(ctx, sr, `${path}.scriptRef`);
  for (const [k] of m.entries) {
    if (typeof k !== "bigint" || k > 3n) ctx.warnings.push(`${path}: unknown output key ${String(k)}`);
  }
  return out;
}

// ----------------------------------------------------------------------------------------------
// Certificates

function drep(item: CborItem, path: string): DRep {
  const a = arr(item, path, 1);
  const t = small(a[0], `${path}[0]`);
  if (t === 0 || t === 1) {
    const c: Credential = { type: t === 0 ? "key" : "script", hash: hex(arr(item, path, 2)[1], `${path}.hash`, 28) };
    return { ...c, id: cip129(2, c) };
  }
  if (t === 2) return { type: "alwaysAbstain" };
  if (t === 3) return { type: "alwaysNoConfidence" };
  return fail(path, `unknown drep type ${t}`);
}

function ipv4(b: Uint8Array): string {
  return Array.from(b).join(".");
}

function ipv6(b: Uint8Array): string {
  // The ledger serialises IPv6 as four 32-bit words, each in little-endian byte order.
  const groups: string[] = [];
  for (let w = 0; w < 4; w++) {
    const x = [b[w * 4 + 3]!, b[w * 4 + 2]!, b[w * 4 + 1]!, b[w * 4]!];
    groups.push(((x[0]! << 8) | x[1]!).toString(16), ((x[2]! << 8) | x[3]!).toString(16));
  }
  return groups.join(":");
}

function relay(item: CborItem, path: string): Relay {
  const a = arr(item, path, 2);
  const t = small(a[0], `${path}[0]`);
  const port = (x: CborItem): number | null => nullable(x, (p) => small(p, `${path}.port`));
  if (t === 0) {
    const b = arr(item, path, 4);
    return {
      type: "singleHostAddr",
      port: port(b[1]),
      ipv4: nullable(b[2], (x) => ipv4(bytes(x, `${path}.ipv4`, 4))),
      ipv6: nullable(b[3], (x) => ipv6(bytes(x, `${path}.ipv6`, 16))),
    };
  }
  if (t === 1) {
    const b = arr(item, path, 3);
    return { type: "singleHostName", port: port(b[1]), dnsName: text(b[2], `${path}.dnsName`) };
  }
  if (t === 2) return { type: "multiHostName", dnsName: text(a[1], `${path}.dnsName`) };
  return fail(path, `unknown relay type ${t}`);
}

function certificate(ctx: Ctx, item: CborItem, path: string): Certificate {
  const a = arr(item, path, 1);
  const t = small(a[0], `${path}[0]`);
  const at = (i: number): CborItem => {
    if (a.length <= i) fail(path, `certificate type ${t} needs ${i + 1} elements`);
    return a[i];
  };
  const cred = (i: number): Credential => credential(at(i), `${path}.credential`);
  const pool = (i: number): { pool: string; poolId: string } => {
    const h = hex(at(i), `${path}.pool`, 28);
    return { pool: h, poolId: poolId(h) };
  };
  const coin = (i: number, name: string): bigint => uint(at(i), `${path}.${name}`);
  const optAnchor = (i: number): Anchor | null => nullable(at(i), (x) => anchor(x, `${path}.anchor`));
  switch (t) {
    case 0:
      return { type: "stakeRegistration", credential: cred(1) };
    case 1:
      return { type: "stakeDeregistration", credential: cred(1) };
    case 2: {
      const p = pool(2);
      return { type: "stakeDelegation", credential: cred(1), poolId: p.poolId, pool: p.pool };
    }
    case 3: {
      const operator = hex(at(1), `${path}.operator`, 28);
      const md = at(9);
      return {
        type: "poolRegistration",
        operator,
        poolId: poolId(operator),
        vrfKeyHash: hex(at(2), `${path}.vrfKeyHash`, 32),
        pledge: coin(3, "pledge"),
        cost: coin(4, "cost"),
        margin: rational(at(5), `${path}.margin`),
        rewardAccount: address(at(6), `${path}.rewardAccount`),
        owners: set(at(7), `${path}.owners`).map((o, i) => hex(o, `${path}.owners[${i}]`, 28)),
        relays: arr(at(8), `${path}.relays`).map((r, i) => relay(r, `${path}.relays[${i}]`)),
        metadata: nullable(md, (x) => anchor(x, `${path}.metadata`)),
      };
    }
    case 4: {
      const p = pool(1);
      return { type: "poolRetirement", pool: p.pool, poolId: p.poolId, epoch: uint(at(2), `${path}.epoch`) };
    }
    case 5:
      return {
        type: "genesisKeyDelegation",
        genesisHash: hex(at(1), `${path}.genesisHash`),
        genesisDelegateHash: hex(at(2), `${path}.genesisDelegateHash`),
        vrfKeyHash: hex(at(3), `${path}.vrfKeyHash`),
      };
    case 6: {
      const mir = arr(at(1), `${path}.mir`, 2);
      const potId = small(mir[0], `${path}.pot`);
      if (potId > 1) fail(path, `unknown MIR pot ${potId}`);
      const pot = potId === 0 ? "reserves" : "treasury";
      if (mir[1] instanceof CborMap) {
        return {
          type: "moveInstantaneousRewards",
          pot,
          rewards: mir[1].entries.map(([k, v], i) => ({
            credential: credential(k, `${path}.rewards[${i}]`),
            amount: int(v, `${path}.rewards[${i}].amount`),
          })),
        };
      }
      return { type: "moveInstantaneousRewards", pot, otherPot: uint(mir[1], `${path}.otherPot`) };
    }
    case 7:
      return { type: "registration", credential: cred(1), deposit: coin(2, "deposit") };
    case 8:
      return { type: "unregistration", credential: cred(1), refund: coin(2, "refund") };
    case 9:
      return { type: "voteDelegation", credential: cred(1), drep: drep(at(2), `${path}.drep`) };
    case 10: {
      const p = pool(2);
      return { type: "stakeVoteDelegation", credential: cred(1), pool: p.pool, poolId: p.poolId, drep: drep(at(3), `${path}.drep`) };
    }
    case 11: {
      const p = pool(2);
      return { type: "stakeRegistrationDelegation", credential: cred(1), pool: p.pool, poolId: p.poolId, deposit: coin(3, "deposit") };
    }
    case 12:
      return { type: "voteRegistrationDelegation", credential: cred(1), drep: drep(at(2), `${path}.drep`), deposit: coin(3, "deposit") };
    case 13: {
      const p = pool(2);
      return {
        type: "stakeVoteRegistrationDelegation",
        credential: cred(1),
        pool: p.pool,
        poolId: p.poolId,
        drep: drep(at(3), `${path}.drep`),
        deposit: coin(4, "deposit"),
      };
    }
    case 14: {
      const cold = credential(at(1), `${path}.coldCredential`);
      const hot = credential(at(2), `${path}.hotCredential`);
      return { type: "committeeHotAuthorization", coldCredential: cold, hotCredential: hot, coldId: cip129(1, cold), hotId: cip129(0, hot) };
    }
    case 15: {
      const cold = credential(at(1), `${path}.coldCredential`);
      return { type: "committeeColdResignation", coldCredential: cold, coldId: cip129(1, cold), anchor: optAnchor(2) };
    }
    case 16: {
      const c = cred(1);
      return { type: "drepRegistration", credential: c, drepId: cip129(2, c), deposit: coin(2, "deposit"), anchor: optAnchor(3) };
    }
    case 17: {
      const c = cred(1);
      return { type: "drepUnregistration", credential: c, drepId: cip129(2, c), refund: coin(2, "refund") };
    }
    case 18: {
      const c = cred(1);
      return { type: "drepUpdate", credential: c, drepId: cip129(2, c), anchor: optAnchor(2) };
    }
    default:
      ctx.warnings.push(`${path}: unknown certificate type ${t}`);
      return { type: "unknown", tag: t, cbor: rawHex(ctx, item) };
  }
}

// ----------------------------------------------------------------------------------------------
// Protocol parameter updates and governance

const PPU_NAMES: Record<number, string> = {
  0: "minFeeA",
  1: "minFeeB",
  2: "maxBlockBodySize",
  3: "maxTxSize",
  4: "maxBlockHeaderSize",
  5: "keyDeposit",
  6: "poolDeposit",
  7: "maxEpoch",
  8: "nOpt",
  9: "poolPledgeInfluence",
  10: "monetaryExpansion",
  11: "treasuryCut",
  12: "decentralization",
  13: "extraEntropy",
  14: "protocolVersion",
  15: "minUtxoValue",
  16: "minPoolCost",
  17: "coinsPerUtxoByte",
  18: "costModels",
  19: "executionPrices",
  20: "maxTxExUnits",
  21: "maxBlockExUnits",
  22: "maxValueSize",
  23: "collateralPercentage",
  24: "maxCollateralInputs",
  25: "poolVotingThresholds",
  26: "drepVotingThresholds",
  27: "committeeMinSize",
  28: "committeeMaxTermLength",
  29: "govActionLifetime",
  30: "govActionDeposit",
  31: "drepDeposit",
  32: "drepActivity",
  33: "minFeeRefScriptCostPerByte",
};

const POOL_THRESHOLDS = ["motionNoConfidence", "committeeNormal", "committeeNoConfidence", "hardForkInitiation", "ppSecurityGroup"];
const DREP_THRESHOLDS = [
  "motionNoConfidence",
  "committeeNormal",
  "committeeNoConfidence",
  "updateToConstitution",
  "hardForkInitiation",
  "ppNetworkGroup",
  "ppEconomicGroup",
  "ppTechnicalGroup",
  "ppGovGroup",
  "treasuryWithdrawal",
];
const LANGS = ["plutusV1", "plutusV2", "plutusV3"];

function exUnits(item: CborItem, path: string): { memory: bigint; steps: bigint } {
  const a = arr(item, path, 2);
  return { memory: uint(a[0], `${path}.memory`), steps: uint(a[1], `${path}.steps`) };
}

function thresholds(item: CborItem, names: string[], path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  arr(item, path).forEach((x, i) => {
    out[names[i] ?? `threshold${i}`] = rational(x, `${path}[${i}]`);
  });
  return out;
}

function ppuValue(ctx: Ctx, key: number, v: CborItem, path: string): unknown {
  switch (key) {
    case 9:
    case 10:
    case 11:
    case 12:
    case 33:
      return rational(v, path);
    case 13: {
      const a = arr(v, path, 1);
      return small(a[0], path) === 0 ? { type: "neutral" } : { type: "nonce", hash: hex(a[1], path) };
    }
    case 14: {
      const a = arr(v, path, 2);
      return { major: small(a[0], path), minor: small(a[1], path) };
    }
    case 18: {
      const out: Record<string, bigint[]> = {};
      for (const [k, list] of map(v, path).entries) {
        const lang = typeof k === "bigint" ? Number(k) : -1;
        // Plutus V1 cost models were (incorrectly) double-encoded as bytes in some eras; keep both forms.
        const name = LANGS[lang] ?? `language${String(k)}`;
        if (list instanceof Uint8Array) {
          const inner = decodeCborDocument(list).root;
          out[name] = arr(inner, `${path}.${name}`).map((x, i) => int(x, `${path}.${name}[${i}]`));
        } else {
          out[name] = arr(list, `${path}.${name}`).map((x, i) => int(x, `${path}.${name}[${i}]`));
        }
      }
      return out;
    }
    case 19: {
      const a = arr(v, path, 2);
      return { memory: rational(a[0], `${path}.memory`), steps: rational(a[1], `${path}.steps`) };
    }
    case 20:
    case 21:
      return exUnits(v, path);
    case 25:
      return thresholds(v, POOL_THRESHOLDS, path);
    case 26:
      return thresholds(v, DREP_THRESHOLDS, path);
    default:
      if (typeof v === "bigint") return v;
      ctx.warnings.push(`${path}: unexpected value for protocol parameter ${key}`);
      return { cbor: typeof v === "object" && v !== null && !(v instanceof Uint8Array) ? rawHex(ctx, v) : String(v) };
  }
}

function protocolParamUpdate(ctx: Ctx, item: CborItem, path: string): ProtocolParamUpdate {
  const m = map(item, path);
  const out: ProtocolParamUpdate = {};
  for (const [k, v, i] of intKeyed(m, path, ctx)) {
    const name = PPU_NAMES[k];
    if (name) out[name] = ppuValue(ctx, k, v, `${path}.${name}`);
    else {
      ctx.warnings.push(`${path}: unknown protocol parameter key ${k}`);
      out[`unknown_${k}`] = { cbor: toHex(ctx.doc.rawMapValue(m, i)) };
    }
  }
  return out;
}

function update(ctx: Ctx, item: CborItem, path: string): Update {
  const a = arr(item, path, 2);
  return {
    proposals: map(a[0], `${path}.proposals`).entries.map(([k, v], i) => ({
      genesisKeyHash: hex(k, `${path}.proposals[${i}].genesisKeyHash`),
      parameters: protocolParamUpdate(ctx, v, `${path}.proposals[${i}]`),
    })),
    epoch: uint(a[1], `${path}.epoch`),
  };
}

function govActionIdOf(item: CborItem, path: string): GovActionId {
  const a = arr(item, path, 2);
  const txId = hex(a[0], `${path}.txId`, 32);
  const index = small(a[1], `${path}.index`);
  return { txId, index, id: govActionId(txId, index) };
}

const prevId = (item: CborItem, path: string): GovActionId | null => nullable(item, (x) => govActionIdOf(x, path));

function withdrawalsOf(item: CborItem, path: string): Withdrawal[] {
  return map(item, path).entries.map(([k, v], i) => ({
    rewardAccount: address(k, `${path}[${i}].rewardAccount`),
    amount: uint(v, `${path}[${i}].amount`),
  }));
}

function govAction(ctx: Ctx, item: CborItem, path: string): GovAction {
  const a = arr(item, path, 1);
  const t = small(a[0], `${path}[0]`);
  const at = (i: number): CborItem => {
    if (a.length <= i) fail(path, `gov action ${t} needs ${i + 1} elements`);
    return a[i];
  };
  const policy = (i: number): string | null => nullable(at(i), (x) => hex(x, `${path}.policyHash`, 28));
  switch (t) {
    case 0:
      return {
        type: "parameterChange",
        prevActionId: prevId(at(1), `${path}.prevActionId`),
        update: protocolParamUpdate(ctx, at(2), `${path}.update`),
        policyHash: policy(3),
      };
    case 1: {
      const pv = arr(at(2), `${path}.protocolVersion`, 2);
      return {
        type: "hardForkInitiation",
        prevActionId: prevId(at(1), `${path}.prevActionId`),
        protocolVersion: { major: small(pv[0], path), minor: small(pv[1], path) },
      };
    }
    case 2:
      return { type: "treasuryWithdrawals", withdrawals: withdrawalsOf(at(1), `${path}.withdrawals`), policyHash: policy(2) };
    case 3:
      return { type: "noConfidence", prevActionId: prevId(at(1), `${path}.prevActionId`) };
    case 4:
      return {
        type: "updateCommittee",
        prevActionId: prevId(at(1), `${path}.prevActionId`),
        removed: set(at(2), `${path}.removed`).map((c, i) => credential(c, `${path}.removed[${i}]`)),
        added: map(at(3), `${path}.added`).entries.map(([k, v], i) => ({
          credential: credential(k, `${path}.added[${i}]`),
          expiresEpoch: uint(v, `${path}.added[${i}].epoch`),
        })),
        quorum: rational(at(4), `${path}.quorum`),
      };
    case 5: {
      const c = arr(at(2), `${path}.constitution`, 2);
      return {
        type: "newConstitution",
        prevActionId: prevId(at(1), `${path}.prevActionId`),
        constitution: {
          anchor: anchor(c[0], `${path}.constitution.anchor`),
          scriptHash: nullable(c[1], (x) => hex(x, `${path}.constitution.scriptHash`, 28)),
        },
      };
    }
    case 6:
      return { type: "info" };
    default:
      ctx.warnings.push(`${path}: unknown governance action type ${t}`);
      return { type: "unknown", tag: t, cbor: rawHex(ctx, item) };
  }
}

function proposal(ctx: Ctx, item: CborItem, path: string): ProposalProcedure {
  const a = arr(item, path, 4);
  return {
    deposit: uint(a[0], `${path}.deposit`),
    rewardAccount: address(a[1], `${path}.rewardAccount`),
    govAction: govAction(ctx, a[2], `${path}.govAction`),
    anchor: anchor(a[3], `${path}.anchor`),
  };
}

const VOTER_ROLES: VoterRole[] = [
  "constitutionalCommitteeHotKey",
  "constitutionalCommitteeHotScript",
  "drepKey",
  "drepScript",
  "stakePoolKey",
];

function voter(item: CborItem, path: string): Voter {
  const a = arr(item, path, 2);
  const t = small(a[0], `${path}[0]`);
  const role = VOTER_ROLES[t];
  if (!role) fail(path, `unknown voter type ${t}`);
  const hash = hex(a[1], `${path}.hash`, 28);
  const type = t === 1 || t === 3 ? "script" : "key";
  const id = t <= 1 ? cip129(0, { type, hash }) : t <= 3 ? cip129(2, { type, hash }) : poolId(hash);
  return { role, hash, id };
}

const VOTES = ["no", "yes", "abstain"] as const;

function votingProcedures(item: CborItem, path: string): VotingProcedures[] {
  return map(item, path).entries.map(([k, v], i) => ({
    voter: voter(k, `${path}[${i}].voter`),
    votes: map(v, `${path}[${i}].votes`).entries.map(([gid, proc], j) => {
      const p = arr(proc, `${path}[${i}].votes[${j}]`, 2);
      const n = small(p[0], `${path}[${i}].votes[${j}].vote`);
      const vote = VOTES[n];
      if (!vote) fail(`${path}[${i}].votes[${j}]`, `unknown vote ${n}`);
      return {
        govActionId: govActionIdOf(gid, `${path}[${i}].votes[${j}].govActionId`),
        vote,
        anchor: nullable(p[1], (x) => anchor(x, `${path}[${i}].votes[${j}].anchor`)),
      };
    }),
  }));
}

// ----------------------------------------------------------------------------------------------
// Transaction body

export function txBody(ctx: Ctx, item: CborItem, path: string): Omit<import("./types.js").Transaction,
  "index" | "id" | "valid" | "size" | "witnesses" | "auxiliaryData" | "cbor"> {
  const m = map(item, path);
  const out: ReturnType<typeof txBody> = { inputs: [], outputs: [], fee: 0n, outputLovelace: 0n };
  let sawInputs = false;
  let sawFee = false;
  let sawOutputs = false;
  for (const [k, v, i] of intKeyed(m, path, ctx)) {
    const p = `${path}`;
    switch (k) {
      case 0:
        out.inputs = inputs(v, `${p}.inputs`);
        sawInputs = true;
        break;
      case 1:
        out.outputs = arr(v, `${p}.outputs`).map((o, j) => txOutput(ctx, o, j, `${p}.outputs[${j}]`));
        out.outputLovelace = out.outputs.reduce((s, o) => s + o.value.lovelace, 0n);
        sawOutputs = true;
        break;
      case 2:
        out.fee = uint(v, `${p}.fee`);
        sawFee = true;
        break;
      case 3:
        out.ttl = uint(v, `${p}.ttl`);
        break;
      case 4:
        out.certificates = set(v, `${p}.certificates`).map((c, j) => certificate(ctx, c, `${p}.certificates[${j}]`));
        break;
      case 5:
        out.withdrawals = withdrawalsOf(v, `${p}.withdrawals`);
        break;
      case 6:
        out.update = update(ctx, v, `${p}.update`);
        break;
      case 7:
        out.auxiliaryDataHash = hex(v, `${p}.auxiliaryDataHash`, 32);
        break;
      case 8:
        out.validityStart = uint(v, `${p}.validityStart`);
        break;
      case 9:
        out.mint = multiAsset(v, `${p}.mint`);
        break;
      case 11:
        out.scriptDataHash = hex(v, `${p}.scriptDataHash`, 32);
        break;
      case 13:
        out.collateral = inputs(v, `${p}.collateral`);
        break;
      case 14:
        out.requiredSigners = set(v, `${p}.requiredSigners`).map((x, j) => hex(x, `${p}.requiredSigners[${j}]`, 28));
        break;
      case 15:
        out.networkId = small(v, `${p}.networkId`);
        break;
      case 16:
        out.collateralReturn = txOutput(ctx, v, 0, `${p}.collateralReturn`);
        break;
      case 17:
        out.totalCollateral = uint(v, `${p}.totalCollateral`);
        break;
      case 18:
        out.referenceInputs = inputs(v, `${p}.referenceInputs`);
        break;
      case 19:
        out.votingProcedures = votingProcedures(v, `${p}.votingProcedures`);
        break;
      case 20:
        out.proposalProcedures = set(v, `${p}.proposalProcedures`).map((x, j) => proposal(ctx, x, `${p}.proposalProcedures[${j}]`));
        break;
      case 21:
        out.currentTreasuryValue = uint(v, `${p}.currentTreasuryValue`);
        break;
      case 22:
        out.donation = uint(v, `${p}.donation`);
        break;
      default:
        ctx.warnings.push(`${p}: unknown transaction body key ${k}`);
        (out.unknownFields ??= []).push({ key: k, cbor: toHex(ctx.doc.rawMapValue(m, i)) });
    }
  }
  if (!sawInputs || !sawOutputs || !sawFee) fail(path, "transaction body must contain inputs (0), outputs (1) and fee (2)");
  return out;
}

// ----------------------------------------------------------------------------------------------
// Witnesses

const REDEEMER_TAGS: RedeemerTag[] = ["spend", "mint", "cert", "reward", "vote", "propose"];

function redeemer(ctx: Ctx, tagItem: CborItem, indexItem: CborItem, dataItem: CborItem, dataRaw: Uint8Array, ex: CborItem, path: string): Redeemer {
  const tagId = small(tagItem, `${path}.tag`);
  return {
    tag: REDEEMER_TAGS[tagId] ?? "unknown",
    tagId,
    index: small(indexItem, `${path}.index`),
    data: plutusData(dataItem, `${path}.data`),
    dataCbor: toHex(dataRaw),
    exUnits: exUnits(ex, `${path}.exUnits`),
  };
}

export function witnessSet(ctx: Ctx, item: CborItem, path: string): Witnesses {
  const m = map(item, path);
  const w: Witnesses = { vkeys: [], bootstraps: [], scripts: [], datums: [], redeemers: [] };
  const doc = ctx.doc;
  for (const [k, v, i] of intKeyed(m, path, ctx)) {
    const list = unwrapSet(v);
    switch (k) {
      case 0:
        for (const [j, x] of set(v, `${path}.vkeys`).entries()) {
          const a = arr(x, `${path}.vkeys[${j}]`, 2);
          const vk = bytes(a[0], `${path}.vkeys[${j}].vkey`);
          w.vkeys.push({ vkey: toHex(vk), keyHash: keyHash(vk), signature: hex(a[1], `${path}.vkeys[${j}].signature`) });
        }
        break;
      case 1:
        set(v, `${path}.nativeScripts`).forEach((x, j) => {
          w.scripts.push(nativeScriptEntry(ctx, doc.rawChild(list as CborItem[], j), x, `${path}.nativeScripts[${j}]`));
        });
        break;
      case 2:
        for (const [j, x] of set(v, `${path}.bootstraps`).entries()) {
          const a = arr(x, `${path}.bootstraps[${j}]`, 4);
          const p = `${path}.bootstraps[${j}]`;
          w.bootstraps.push({
            vkey: hex(a[0], `${p}.vkey`),
            signature: hex(a[1], `${p}.signature`),
            chainCode: hex(a[2], `${p}.chainCode`),
            attributes: hex(a[3], `${p}.attributes`),
          });
        }
        break;
      case 3:
      case 6:
      case 7: {
        const version = k === 3 ? 1 : k === 6 ? 2 : 3;
        set(v, `${path}.plutusScripts`).forEach((x, j) => {
          w.scripts.push(plutusScriptEntry(version, bytes(x, `${path}.plutusV${version}Scripts[${j}]`)));
        });
        break;
      }
      case 4:
        set(v, `${path}.datums`).forEach((x, j) => {
          w.datums.push(datum(doc.rawChild(list as CborItem[], j), x, `${path}.datums[${j}]`));
        });
        break;
      case 5:
        if (v instanceof CborMap) {
          v.entries.forEach(([key, val], j) => {
            const p = `${path}.redeemers[${j}]`;
            const ka = arr(key, p, 2);
            const va = arr(val, p, 2);
            w.redeemers.push(redeemer(ctx, ka[0], ka[1], va[0], doc.rawChild(va, 0), va[1], p));
          });
        } else {
          arr(v, `${path}.redeemers`).forEach((x, j) => {
            const p = `${path}.redeemers[${j}]`;
            const a = arr(x, p, 4);
            w.redeemers.push(redeemer(ctx, a[0], a[1], a[2], doc.rawChild(a, 2), a[3], p));
          });
        }
        break;
      default:
        ctx.warnings.push(`${path}: unknown witness set key ${k}`);
        (w.unknown ??= []).push({ key: k, cbor: toHex(doc.rawMapValue(m, i)) });
    }
  }
  return w;
}

// ----------------------------------------------------------------------------------------------
// Auxiliary data

function metadataMap(ctx: Ctx, item: CborItem, path: string): AuxiliaryData["metadata"] {
  return map(item, path).entries.map(([k, v], i) => ({ label: uint(k, `${path}[${i}].label`), value: metadatum(v, `${path}[${i}]`) }));
}

export function auxiliaryData(ctx: Ctx, item: CborItem, raw: Uint8Array, path: string): AuxiliaryData {
  const out: AuxiliaryData = { hash: toHex(blake2b256(raw)), format: "shelley", metadata: [], scripts: [] };
  if (item instanceof CborMap) {
    out.metadata = metadataMap(ctx, item, `${path}.metadata`);
  } else if (Array.isArray(item)) {
    out.format = "shelley-ma";
    const a = arr(item, path, 2);
    out.metadata = metadataMap(ctx, a[0], `${path}.metadata`);
    const scripts = arr(a[1], `${path}.scripts`);
    scripts.forEach((s, j) => out.scripts.push(nativeScriptEntry(ctx, ctx.doc.rawChild(scripts, j), s, `${path}.scripts[${j}]`)));
  } else if (item instanceof CborTag && item.tag === 259n) {
    out.format = "alonzo";
    const m = map(item.value, path);
    for (const [k, v] of intKeyed(m, path, ctx)) {
      if (k === 0) out.metadata = metadataMap(ctx, v, `${path}.metadata`);
      else if (k === 1) {
        const list = unwrapSet(v) as CborItem[];
        set(v, `${path}.nativeScripts`).forEach((s, j) =>
          out.scripts.push(nativeScriptEntry(ctx, ctx.doc.rawChild(list, j), s, `${path}.nativeScripts[${j}]`)),
        );
      } else if (k >= 2 && k <= 4) {
        const version = (k - 1) as 1 | 2 | 3;
        set(v, `${path}.plutusScripts`).forEach((s, j) => out.scripts.push(plutusScriptEntry(version, bytes(s, `${path}.plutusScripts[${j}]`))));
      } else ctx.warnings.push(`${path}: unknown auxiliary data key ${k}`);
    }
  } else {
    fail(path, "unrecognised auxiliary data encoding");
  }
  if (ctx.includeCbor) out.cbor = toHex(raw);
  return out;
}

export { bool };
