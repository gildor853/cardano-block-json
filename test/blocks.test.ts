import { describe, expect, it } from "vitest";
import {
  blockPoint,
  decodeBlock,
  stringifyBlock,
  toJson,
  type ByronBlock,
  type ByronEpochBoundaryBlock,
  type DecodedBlock,
  type ShelleyBlock,
  type Transaction,
} from "../src/index.js";
import { blake2b256 } from "../src/blake2b.js";
import { decodeCborDocument } from "../src/cbor.js";
import { fromHex, toHex } from "../src/bytes.js";
import { fixture } from "./helpers/fixtures.js";

// Expected values were cross-checked against an independent chain indexer (Koios) for every
// transaction in these blocks: tx ids, fees, sizes, inputs/outputs, addresses, assets, datums,
// reference scripts, certificates, withdrawals, metadata labels and validity intervals.
// [fixture, era, hash, slot, blockNumber, txCount, firstTxId, firstTxFee, firstTxSize, totalFees, totalOutput]
const TABLE: Array<[string, string, string, string, string, number, string | null, string | null, number | null, string | null, string | null]> = [
  ["allegra-mainnet", "allegra", "7d51efcc418fa7eb4bc5201070608ac59773f5f118ac680865657c11dc723384", "17282300", "5120350", 4, "863943f2f2b4ebc37fd5f51644f92cf78ecb2c1b0923c323b07a8d7595ffc664", "173333", 382, "696016", "534754808336"],
  ["alonzo-mainnet", "alonzo", "00a39e4b04ebb4ebb99d9a231602dce9d754695a2ac18c9639379769c388edef", "45368635", "6502299", 10, "e017ef15b6372f3188cb0193297f77e90b2182a04c87e420768d3c88dff089be", "227174", 565, "2088029", "44610492153"],
  ["babbage-mainnet", "babbage", "859db14f00d3ea0a00f5c80430fc8d819eccc7074b1d7901619271b6eb9c9799", "75605258", "7951802", 13, "f2aa0614e8d61e6bf220321cb1c3ec34cf7e106b284307fb989ef1f3bf73a76c", "200481", 1020, "4442575", "21283901424"],
  ["byron-ebb-preprod", "byron-ebb", "9ad7ff320c9cf74e0f5ee78d22a85ce42bb0a487d0506bf60cfb5a91ea4497d2", "0", "0", 0, null, null, null, null, null],
  ["byron-mainnet", "byron", "81e389d83e437012789f6410669a404f1e4ebfa7a46a979f094335e2e78dfd8d", "6315", "6316", 1, "dbc87d198fc9f6067c8e65f89da60a944e1ef52f0c539d980ebbc95f3dc71b65", null, 130, null, "1000000"],
  ["conway-mainnet-committee", "conway", "e7e378ce40ed2067ffc396c6dc561356b14bc617ddcbf314dd2b43caf11099f1", "193952991", "13749401", 3, "1b8a5b61c7584b4831c3ea6b3018550707825709ab6bd8f004cf515a05aaa178", "469155", 2052, "845213", "8367016580"],
  ["conway-mainnet-constitution", "conway", "d17a470fd53b7fa11fc34687ff08aee4f2e5fa0733d1935fe0527d5752d139ed", "146691167", "11420062", 75, "f3e31be44b3bcd55e3e07bb2ec56550cf537d486d2378ce9f92478389b23ac8b", "178745", 526, "26255631", "1268794849030"],
  ["conway-mainnet-hardfork", "conway", "ac8038e5538582f8721a49858ded4f12ae8987b3aca1eab9beed65c9f64e50a1", "143212791", "11248113", 42, "88b0089f0cdca12362765ce5cfa3bf5ae1fa98e79c508c9869c18a627a64ba41", "179000", 363, "11200434", "17158772365528"],
  ["conway-mainnet-paramchange", "conway", "19149de1850ae811788397aabea26627899aec8e92f8829adff8d2b8d16685c9", "147887242", "11479049", 33, "9bdf6a4a3179ad9e84aa18442f134653fefead4d56eac5907a19cb71457c4b2d", "864733", 2177, "9358221", "12541485430853"],
  ["conway-mainnet-treasury", "conway", "04c363af53a43069737439b3edabb5511cc582e8936c7c3da9d91bfcd5e48ba2", "159245440", "12040618", 7, "611edd36295e9ec247ab7f9c36817de90e49380f160ecf4fecc1dfe942c3b67c", "170649", 342, "2543280", "657095938278"],
  ["conway-preprod-empty", "conway", "35f587105301cd4cb8b2bad8ce01ba1ddaa61949d3f5fca2f4bd441abdced5f1", "135864076", "5272115", 0, null, null, null, "0", "0"],
  ["conway-preprod-plutus", "conway", "fbd1b55d540ebe9f2fdf1e738fe0b1d71106f374270bc1ee5927bc534dfaee98", "135864782", "5272144", 5, "6cf077eb38e023541df397834b26dfd3c451552d01abfa772f25d5e5a53a4f09", "246606", 1834, "1937082", "16888700425"],
  ["conway-preprod-votes", "conway", "49d531af6202c79b6618c87f53315e18500204d819f31a45e76a38c53581c0b8", "135865222", "5272164", 3, "e1d4448917273022b6aeca418f724e19efe1b5143e8024c9dc1aebd0b60daafb", "216614", 1169, "1289093", "9608522982"],
  ["conway-preview-empty", "conway", "cc580b9ed2421c0dac7773bb94c92de6fa363e1b28bbc4ed2abc1435493c8011", "125064009", "4747217", 0, null, null, null, "0", "0"],
  ["mary-mainnet", "mary", "8f8a3d4c56bd69a4f1f736a783c4269cf28604717e7f9c63cb775ff8eceff9bd", "23764552", "5440957", 28, "18ee1233bb629a23b104863f633f400546e0fa2903a9e429eae2ffab7ee4311d", "173421", 382, "5549692", "8178173874521"],
  ["mary-mainnet-mint", "mary", "f4ff46f7763c313320cd87670e9d2b43b3856db97981c9ab2f62c41aceb591ed", "23775884", "5441517", 2, "bd0a829c39a49d29b23c7ae2a9b6e8ff35175afbbcef81323d6f0df3c820f626", "173421", 378, "353530", "219646470"],
  ["shelley-mainnet-pool", "shelley", "ad0a0258b6fb9e19b0944d9d3a403d340df2695874a4bd33c46c9abd897e0dd0", "6482634", "4589279", 1, "f1507872a066fe265cc59a76b3a8080cf9bfd1102e347e3e35978a4acb6cc2f1", "202549", 822, "202549", "26476872530"],
  ["shelley-mainnet-update", "shelley", "bb088364b5b1eb0d672a730f1a09d559bcbce8ba4b74f40b411e835fa163d1eb", "16233605", "5069169", 6, "daea2aeec9bf91cdc7ce978b3408259547488fed5c61d593e2745fd8c50fff0d", "168713", 293, "1081602", "239594963164"],
];

const shelley = (name: string): ShelleyBlock => {
  const b = decodeBlock(fixture(name));
  if (b.era === "byron" || b.era === "byron-ebb") throw new Error("not a Shelley-family block");
  return b;
};
const tx = (b: ShelleyBlock, prefix: string): Transaction => {
  const t = b.transactions.find((x) => x.id.startsWith(prefix));
  if (!t) throw new Error(`tx ${prefix} not found`);
  return t;
};

describe("decodeBlock on real blocks from every era", () => {
  it.each(TABLE)("%s", (name, era, hash, slot, blockNumber, txCount, firstId, firstFee, firstSize, totalFees, totalOutput) => {
    const bytes = fixture(name);
    const b = decodeBlock(bytes);
    expect(b.era).toBe(era);
    expect(b.hash).toBe(hash);
    expect(String(b.slot)).toBe(slot);
    expect(String(b.blockNumber)).toBe(blockNumber);
    expect(b.transactions).toHaveLength(txCount);
    expect(b.warnings).toEqual([]);
    expect(blockPoint(bytes)).toEqual({ slot: BigInt(slot), hash, era });
    if (firstId) expect(b.transactions[0]!.id).toBe(firstId);
    if (firstSize !== null) expect(b.transactions[0]!.size).toBe(firstSize);
    if (b.era !== "byron" && b.era !== "byron-ebb") {
      if (firstFee) expect(String(b.transactions[0]!.fee)).toBe(firstFee);
      expect(b.integrity).toMatchObject({ bodyHashValid: true, bodySizeValid: true, auxiliaryDataHashesValid: true });
      expect(String(b.stats.totalFees)).toBe(totalFees);
      expect(b.stats.transactionCount).toBe(txCount);
      expect(b.size).toBe(bytes.length - 2);
    }
    if (totalOutput !== null && b.era !== "byron-ebb") expect(String(b.stats.totalOutputLovelace)).toBe(totalOutput);
    // Always JSON-serialisable after toJson.
    const json = JSON.parse(JSON.stringify(toJson(b))) as { hash: string };
    expect(json.hash).toBe(hash);
  });

  it("decodes Praos (Babbage/Conway) and TPraos (Shelley–Alonzo) headers", () => {
    const c = shelley("conway-preprod-votes").header;
    expect(c).toMatchObject({
      issuerPoolId: "pool1945cfqzmy2qe2z59mfdwm7jwqtucncfee5xkd8f4wu97zr8xuys",
      issuerPoolHash: "2d6984805b2281950a85da5aedfa4e02f989e139cd0d669d35770be1",
      bodySize: 4014,
      protocolVersion: { major: 11, minor: 2 },
      operationalCert: { sequenceNumber: 1n, kesPeriod: 1005n },
      prevHash: "d47f8b4eb8e598f7249569dc60c5866e55371c659cde0b123833d065be7d9d46",
      size: 859,
    });
    expect(c.vrfResult?.output).toHaveLength(128);
    expect(c.vrfResult?.proof).toHaveLength(160);
    expect(c.kesSignature).toHaveLength(448 * 2);
    expect(c.nonceVrf).toBeUndefined();
    const s = shelley("shelley-mainnet-pool").header;
    expect(s.nonceVrf?.output).toHaveLength(128);
    expect(s.leaderVrf?.proof).toHaveLength(160);
    expect(s.vrfResult).toBeUndefined();
    expect(s.protocolVersion).toEqual({ major: 2, minor: 0 });
  });

  it("decodes Conway governance: proposals of every type present on mainnet", () => {
    const hf = tx(shelley("conway-mainnet-hardfork"), "0b19476e");
    expect(hf).toMatchObject({ fee: 183893n, size: 442 });
    expect(hf.proposalProcedures?.[0]).toMatchObject({
      deposit: 100000000000n,
      rewardAccount: { bech32: "stake1uyguuqwdpexmhgjd07vax5t2ay3f7qvea49ex907g6fmvjclq6l03" },
      govAction: { type: "hardForkInitiation", prevActionId: null, protocolVersion: { major: 10, minor: 0 } },
      anchor: { url: "https://raw.githubusercontent.com/IntersectMBO/governance-actions/refs/heads/main/mainnet/2024-10-30-hf10/metadata.jsonld" },
    });
    const nc = tx(shelley("conway-mainnet-constitution"), "8c653ee5").proposalProcedures?.[0]?.govAction;
    expect(nc).toMatchObject({
      type: "newConstitution",
      constitution: {
        anchor: { url: "ipfs://bafkreiazhhawe7sjwuthcfgl3mmv2swec7sukvclu3oli7qdyz4uhhuvmy" },
        scriptHash: "fa24fb305126805cf2164c161d852a0e7330cf988f1fe558cf7d4a64",
      },
    });
    const pc = tx(shelley("conway-mainnet-paramchange"), "941502b0");
    expect(pc).toMatchObject({ fee: 323076n, size: 2855 });
    expect(pc.proposalProcedures?.[0]?.govAction).toMatchObject({ type: "parameterChange", update: { treasuryCut: { numerator: expect.any(BigInt) } } });
    const tw = tx(shelley("conway-mainnet-treasury"), "60ed6ab4");
    expect(tw).toMatchObject({ fee: 343204n, size: 3533 });
    const action = tw.proposalProcedures?.[0]?.govAction;
    expect(action?.type).toBe("treasuryWithdrawals");
    if (action?.type === "treasuryWithdrawals") {
      expect(action.withdrawals[0]).toMatchObject({ amount: 100000000000n, rewardAccount: { type: "reward", stakeCredential: { type: "script" } } });
      expect(action.policyHash).toBe("fa24fb305126805cf2164c161d852a0e7330cf988f1fe558cf7d4a64");
    }
    const uc = tx(shelley("conway-mainnet-committee"), "729daaf2");
    expect(uc).toMatchObject({ fee: 194761n, size: 693 });
    expect(uc.proposalProcedures?.[0]?.govAction).toMatchObject({
      type: "updateCommittee",
      prevActionId: {
        txId: "4dab331457b61b824bbc6ba4b9d9be4750e25c0b5dd42207aeb63c7431a6b704",
        index: 0,
        id: "gov_action1fk4nx9zhkcdcyjaudwjtnkd7gagwyhqtth2zypawkc78gvdxkuzqqtvqdkv",
      },
      quorum: { numerator: 2n, denominator: 3n },
    });
  });

  it("decodes votes, DRep certificates and vote redeemers", () => {
    const b = shelley("conway-preprod-votes");
    const reg = b.transactions[0]!.certificates?.[0];
    expect(reg).toMatchObject({
      type: "drepRegistration",
      drepId: "drep1y0uu23jfngtrqyxs6z78jjm9d9960nutcry50h5ag9wxqvcjgjxra",
      deposit: 500000000n,
      anchor: { url: "https://raw.githubusercontent.com/cardano-foundation/CIPs/master/CIP-0119/examples/drep.jsonld" },
    });
    const v = b.transactions[2]!;
    expect(v.votingProcedures).toEqual([
      {
        voter: { role: "drepScript", hash: "b95112fc27cf78eefaa4327a6d6bbfe5896a683ce51ec2c8b23b2f63", id: "drep1ywu4zyhuyl8h3mh65se85mtthljcj6ng8nj3askgkgaj7ccfwe9my" },
        votes: [
          {
            govActionId: {
              txId: "139444b23543a9a836b2b01c0057ff4300f2d25b3d94812f138b89b22d2b780d",
              index: 0,
              id: "gov_action1zw2yfv34gw56sd4jkqwqq4llgvq095jm8k2gztcn3wymytft0qxsqhpp4x8",
            },
            vote: "abstain",
            anchor: null,
          },
        ],
      },
    ]);
    expect(v.witnesses.redeemers.map((r) => r.tag)).toContain("vote");
    expect(v.witnesses.scripts.some((s) => s.language === "native")).toBe(true);
  });

  it("decodes Plutus V3 scripts, inline datums, reference scripts and redeemers", () => {
    const b = shelley("conway-preprod-plutus");
    const all = b.transactions;
    const inline = all.flatMap((t) => t.outputs).find((o) => o.inlineDatum);
    expect(inline?.format).toBe("map");
    expect(inline?.inlineDatum?.hash).toBe(toHex(blake2b256(fromHex(inline!.inlineDatum!.cbor)!)));
    const ref = all.flatMap((t) => t.outputs).find((o) => o.scriptRef);
    expect(ref?.scriptRef?.language).toBe("plutusV3");
    expect(all.some((t) => t.witnesses.redeemers.some((r) => r.tag === "spend" && r.exUnits.memory > 0n))).toBe(true);
    expect(all.some((t) => t.collateralReturn && t.totalCollateral !== undefined)).toBe(true);
    expect(all.some((t) => (t.referenceInputs ?? []).length > 0)).toBe(true);
  });

  it("decodes Alonzo Plutus V1 scripts, witness datums and legacy redeemers", () => {
    const b = shelley("alonzo-mainnet");
    const t = b.transactions.find((x) => x.witnesses.scripts.some((s) => s.language === "plutusV1"))!;
    expect(t.witnesses.datums.length).toBeGreaterThan(0);
    for (const d of t.witnesses.datums) expect(d.hash).toBe(toHex(blake2b256(fromHex(d.cbor)!)));
    expect(t.witnesses.redeemers[0]).toMatchObject({ tag: "spend", data: expect.any(Object) });
    expect(t.scriptDataHash).toHaveLength(64);
    expect(t.collateral?.length).toBeGreaterThan(0);
    expect(b.transactions.some((x) => x.outputs.some((o) => o.datumHash))).toBe(true);
  });

  it("decodes Babbage outputs and metadata", () => {
    const b = shelley("babbage-mainnet");
    expect(b.transactions.some((t) => t.outputs.some((o) => o.inlineDatum))).toBe(true);
    const meta = b.transactions.find((t) => t.auxiliaryData)!.auxiliaryData!;
    expect(meta.format).toMatch(/shelley|alonzo/);
    expect(meta.metadata.length).toBeGreaterThan(0);
  });

  it("decodes Mary multi-assets, mint, native minting policies and fingerprints", () => {
    const b = shelley("mary-mainnet-mint");
    const t = tx(b, "d71158157be0");
    expect(t).toMatchObject({ fee: 180109n, size: 423 });
    expect(t.mint).toEqual([
      {
        policyId: "9a7f99745a4927814a4d7be434341a33c9956a3a28d9a9daaf9213c2",
        assetName: "676172746c79636f696e",
        assetNameUtf8: "gartlycoin",
        fingerprint: "asset1mpx8f9hmaz2n0awc9a6nn8qxwpnfee6wt4e7q4",
        quantity: 7000000n,
      },
    ]);
    // The policy id is the hash of the native script that witnesses the mint.
    expect(t.witnesses.scripts[0]).toMatchObject({
      language: "native",
      hash: "9a7f99745a4927814a4d7be434341a33c9956a3a28d9a9daaf9213c2",
      script: { type: "sig", keyHash: "520c3ef83eb237dba2884ee4fc296c7becf7913a532249e05350861f" },
    });
    expect(t.outputs.some((o) => o.value.assets.some((a) => a.policyId === t.mint![0]!.policyId))).toBe(true);
    expect(shelley("mary-mainnet").transactions.some((x) => x.certificates?.some((c) => c.type === "poolRetirement"))).toBe(true);
  });

  it("decodes Allegra Shelley-MA auxiliary data", () => {
    const b = shelley("allegra-mainnet");
    const aux = b.transactions.find((t) => t.auxiliaryData)!.auxiliaryData!;
    expect(aux.format).toBe("shelley-ma");
    expect(aux.hash).toBe(b.transactions.find((t) => t.auxiliaryData)!.auxiliaryDataHash);
  });

  it("decodes Shelley pool registrations and bootstrap witnesses", () => {
    const b = shelley("shelley-mainnet-pool");
    const t = b.transactions[0]!;
    const reg = t.certificates?.find((c) => c.type === "poolRegistration");
    expect(reg).toMatchObject({ type: "poolRegistration", poolId: expect.stringMatching(/^pool1/), margin: { denominator: expect.any(BigInt) } });
    if (reg?.type === "poolRegistration") {
      expect(reg.relays.length).toBeGreaterThan(0);
      expect(reg.rewardAccount.type).toBe("reward");
      expect(reg.owners.length).toBeGreaterThan(0);
    }
    const update = shelley("shelley-mainnet-update").transactions.find((x) => x.update)!.update!;
    expect(update.epoch).toBe(235n);
    expect(update.proposals).toHaveLength(7);
    expect(update.proposals[0]!.parameters).toEqual({ protocolVersion: { major: 3, minor: 0 } });
  });

  it("decodes Byron main and epoch-boundary blocks", () => {
    const b = decodeBlock(fixture("byron-mainnet")) as ByronBlock;
    expect(b).toMatchObject({ era: "byron", epoch: 0n, slotInEpoch: 6315n, header: { protocolMagic: 764824073 } });
    const t = b.transactions[0]!;
    expect(t.inputs[0]).toMatchObject({ type: 0, index: expect.any(Number) });
    expect(t.outputs[0]!.address.base58).toMatch(/^(Ae2|DdzFF)/);
    // An AVVM redemption witness.
    expect(t.witnesses[0]).toMatchObject({ type: "redeem", typeId: 2, vkey: expect.any(String), signature: expect.any(String) });
    expect(b.header.protocolVersion).toEqual({ major: 0, minor: 0, alt: 0 });
    const ebb = decodeBlock(fixture("byron-ebb-preprod")) as ByronEpochBoundaryBlock;
    expect(ebb).toMatchObject({ era: "byron-ebb", epoch: 0n, header: { protocolMagic: 1 } });
    expect(decodeBlock(fixture("byron-mainnet"), { byronSlotsPerEpoch: 1000 }).slot).toBe(6315n);
  });
});

describe("input forms and options", () => {
  const bytes = fixture("conway-preprod-votes");
  const expected = decodeBlock(bytes);

  it("accepts hex, 0x-hex, Buffer, ArrayBuffer and tag-24 wrapped input", () => {
    expect(decodeBlock(toHex(bytes)).hash).toBe(expected.hash);
    expect(decodeBlock(`0x${toHex(bytes).toUpperCase()}\n`).hash).toBe(expected.hash);
    expect(decodeBlock(Buffer.from(bytes)).hash).toBe(expected.hash);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    expect(decodeBlock(ab).hash).toBe(expected.hash);
    const len = bytes.length;
    const tagged = new Uint8Array([0xd8, 0x18, 0x59, len >> 8, len & 0xff, ...bytes]);
    expect(decodeBlock(tagged).hash).toBe(expected.hash);
    expect(blockPoint(tagged).hash).toBe(expected.hash);
  });

  it("accepts a bare era block and infers the era", () => {
    for (const name of ["conway-preprod-votes", "babbage-mainnet", "alonzo-mainnet", "mary-mainnet", "allegra-mainnet", "shelley-mainnet-pool", "byron-mainnet", "byron-ebb-preprod"]) {
      const wrapped = fixture(name);
      const doc = decodeCborDocument(wrapped);
      const bare = doc.rawChild(doc.root as never, 1);
      const a = decodeBlock(wrapped);
      const b = decodeBlock(bare);
      expect(b.hash, name).toBe(a.hash);
      // Allegra blocks already signal protocol version 4 (Mary), so the inferred era can be one ahead.
      if (name !== "allegra-mainnet") expect(b.era, name).toBe(a.era);
      if (b.era !== "byron" && b.era !== "byron-ebb") expect(b.warnings[0]).toMatch(/inferred/);
      const explicit = decodeBlock(bare, { era: a.era as never });
      expect(explicit.hash).toBe(a.hash);
      expect(explicit.era).toBe(a.era);
      expect(explicit.warnings).toEqual([]);
    }
  });

  it("includeCbor returns exact segments", () => {
    const b = decodeBlock(bytes, { includeCbor: true }) as ShelleyBlock;
    expect(b.cbor).toBe(toHex(bytes.subarray(2)));
    for (const t of b.transactions) {
      expect(toHex(blake2b256(fromHex(t.cbor!.body)!))).toBe(t.id);
      expect(t.cbor!.witnesses.length).toBeGreaterThan(0);
      if (t.auxiliaryData) expect(t.auxiliaryData.cbor).toBe(t.cbor!.auxiliaryData);
    }
    const byron = decodeBlock(fixture("byron-mainnet"), { includeCbor: true }) as ByronBlock;
    expect(byron.transactions[0]!.cbor).toBeTypeOf("string");
    expect(decodeBlock(fixture("byron-ebb-preprod"), { includeCbor: true }).cbor).toBeTypeOf("string");
  });
});

describe("toJson", () => {
  it("renders bigints as strings by default and as numbers when asked", () => {
    const b = decodeBlock(fixture("conway-preprod-votes"));
    const s = toJson(b) as { slot: string; transactions: Array<{ fee: string }> };
    expect(s.slot).toBe("135865222");
    expect(s.transactions[0]!.fee).toBe("216614");
    const n = toJson(b, { bigint: "number" }) as { slot: number };
    expect(n.slot).toBe(135865222);
    expect(toJson({ big: 2n ** 70n, neg: -(2n ** 70n) }, { bigint: "number" })).toEqual({ big: "1180591620717411303424", neg: "-1180591620717411303424" });
    expect(toJson({ a: undefined, b: Uint8Array.of(1, 255), c: [1n], d: null })).toEqual({ b: "01ff", c: ["1"], d: null });
    expect(JSON.parse(stringifyBlock(b, { indent: 0 })).hash).toBe(b.hash);
    expect(stringifyBlock({ x: 1n })).toBe('{\n  "x": "1"\n}');
  });
});

export type { DecodedBlock };
