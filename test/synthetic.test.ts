import { describe, expect, it } from "vitest";
import { decodeBlock, type ShelleyBlock, type Transaction } from "../src/index.js";
import { blake2b224, blake2b256 } from "../src/blake2b.js";
import { encodeCbor, type CborEncodable } from "../src/cbor.js";
import { concatBytes, toHex } from "../src/bytes.js";
import { ANCHOR, b, body, buildBlock, cred, ENT_ADDR, input, KEY, m, REWARD, set, tag } from "./helpers/build.js";

const one = (bodyExtra: Array<[number, CborEncodable]>, wits: CborEncodable = m(), extra: Partial<Parameters<typeof buildBlock>[0]> = {}): { block: ShelleyBlock; tx: Transaction } => {
  const block = decodeBlock(buildBlock({ bodies: [body(bodyExtra)], witnesses: [wits], ...extra })) as ShelleyBlock;
  expect(block.integrity.bodyHashValid).toBe(true);
  expect(block.integrity.bodySizeValid).toBe(true);
  return { block, tx: block.transactions[0]! };
};

const KEYHEX = toHex(KEY);

describe("synthetic blocks: certificates", () => {
  it("decodes every certificate type", () => {
    const pool = b(28, 0x55);
    const certs: CborEncodable[] = [
      [0, cred()],
      [1, cred(1)],
      [2, cred(), pool],
      [
        3,
        pool,
        b(32, 0x66),
        500000000,
        340000000,
        tag(30, [1, 50]),
        REWARD,
        set([KEY]),
        [[0, 3001, Uint8Array.of(1, 2, 3, 4), null], [0, null, null, Uint8Array.of(0xb8, 0x0d, 0x01, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0)], [1, 6000, "relay.example.org"], [2, "pool.example.org"]],
        ["https://example.org/pool.json", b(32, 0x77)],
      ],
      [4, pool, 300],
      [5, b(28, 1), b(28, 2), b(32, 3)],
      [6, [0, m([cred(), 10], [cred(1), -5])]],
      [6, [1, 1000]],
      [7, cred(), 2000000],
      [8, cred(), 2000000],
      [9, cred(), [0, KEY]],
      [10, cred(), pool, [1, KEY]],
      [11, cred(), pool, 2000000],
      [12, cred(), [2], 2000000],
      [13, cred(), pool, [3], 2000000],
      [14, cred(), cred(1)],
      [15, cred(), ANCHOR],
      [15, cred(), null],
      [16, cred(), 500000000, ANCHOR],
      [17, cred(1), 500000000],
      [18, cred(), null],
      [99, 1, 2],
    ];
    const { block, tx } = one([[4, set(certs)]]);
    const c = tx.certificates!;
    expect(c.map((x) => x.type)).toEqual([
      "stakeRegistration",
      "stakeDeregistration",
      "stakeDelegation",
      "poolRegistration",
      "poolRetirement",
      "genesisKeyDelegation",
      "moveInstantaneousRewards",
      "moveInstantaneousRewards",
      "registration",
      "unregistration",
      "voteDelegation",
      "stakeVoteDelegation",
      "stakeRegistrationDelegation",
      "voteRegistrationDelegation",
      "stakeVoteRegistrationDelegation",
      "committeeHotAuthorization",
      "committeeColdResignation",
      "committeeColdResignation",
      "drepRegistration",
      "drepUnregistration",
      "drepUpdate",
      "unknown",
    ]);
    expect(c[0]).toEqual({ type: "stakeRegistration", credential: { type: "key", hash: KEYHEX } });
    expect(c[1]).toMatchObject({ credential: { type: "script" } });
    expect(c[2]).toMatchObject({ pool: "55".repeat(28), poolId: expect.stringMatching(/^pool1/) });
    expect(c[3]).toMatchObject({
      pledge: 500000000n,
      cost: 340000000n,
      margin: { numerator: 1n, denominator: 50n },
      rewardAccount: { type: "reward" },
      owners: [KEYHEX],
      relays: [
        { type: "singleHostAddr", port: 3001, ipv4: "1.2.3.4", ipv6: null },
        { type: "singleHostAddr", port: null, ipv4: null, ipv6: "2001:db8:0:0:0:0:0:1" },
        { type: "singleHostName", port: 6000, dnsName: "relay.example.org" },
        { type: "multiHostName", dnsName: "pool.example.org" },
      ],
      metadata: { url: "https://example.org/pool.json", dataHash: "77".repeat(32) },
    });
    expect(c[4]).toMatchObject({ epoch: 300n });
    expect(c[5]).toMatchObject({ genesisHash: "01".repeat(28) });
    expect(c[6]).toEqual({
      type: "moveInstantaneousRewards",
      pot: "reserves",
      rewards: [
        { credential: { type: "key", hash: KEYHEX }, amount: 10n },
        { credential: { type: "script", hash: KEYHEX }, amount: -5n },
      ],
    });
    expect(c[7]).toEqual({ type: "moveInstantaneousRewards", pot: "treasury", otherPot: 1000n });
    expect(c[8]).toMatchObject({ deposit: 2000000n });
    expect(c[9]).toMatchObject({ refund: 2000000n });
    expect(c[10]).toMatchObject({ drep: { type: "key", hash: KEYHEX, id: expect.stringMatching(/^drep1/) } });
    expect(c[11]).toMatchObject({ drep: { type: "script" } });
    expect(c[13]).toMatchObject({ drep: { type: "alwaysAbstain" } });
    expect(c[14]).toMatchObject({ drep: { type: "alwaysNoConfidence" }, deposit: 2000000n });
    expect(c[15]).toMatchObject({ coldId: expect.stringMatching(/^cc_cold1/), hotId: expect.stringMatching(/^cc_hot1/) });
    expect(c[16]).toMatchObject({ anchor: { url: "https://example.org/a.json" } });
    expect(c[17]).toMatchObject({ anchor: null });
    expect(c[18]).toMatchObject({ drepId: expect.stringMatching(/^drep1/), deposit: 500000000n });
    expect(c[21]).toMatchObject({ type: "unknown", tag: 99, cbor: "83186301" + "02" });
    expect(block.warnings).toEqual([expect.stringMatching(/unknown certificate type 99/)]);
  });

  it("rejects malformed certificates with a path", () => {
    const bad = buildBlock({ bodies: [body([[4, [[2, cred()]]]])], witnesses: [m()] });
    expect(() => decodeBlock(bad)).toThrow(/transactions\[0\]\.body\.certificates\[0\]: certificate type 2 needs 3 elements/);
    expect(() => decodeBlock(buildBlock({ bodies: [body([[4, [[9, cred(), [7]]]]])], witnesses: [m()] }))).toThrow(/unknown drep type 7/);
    expect(() => decodeBlock(buildBlock({ bodies: [body([[4, [[0, [2, KEY]]]]])], witnesses: [m()] }))).toThrow(/unknown credential type 2/);
    expect(() => decodeBlock(buildBlock({ bodies: [body([[4, [[6, [2, 5]]]]])], witnesses: [m()] }))).toThrow(/unknown MIR pot/);
    expect(() =>
      decodeBlock(buildBlock({ bodies: [body([[4, [[3, KEY, b(32), 1, 1, tag(30, [0, 1]), REWARD, [], [[7]], null]]]])], witnesses: [m()] })),
    ).toThrow(/relay/);
  });
});

describe("synthetic blocks: governance", () => {
  it("decodes all governance actions and protocol parameter updates", () => {
    const prev = [b(32, 0x99), 3];
    const ppu = m(
      [0, 44],
      [1, 155381],
      [9, tag(30, [3, 10])],
      [12, tag(30, [1, 2])],
      [13, [1, b(32, 7)]],
      [14, [9, 1]],
      [17, 4310],
      [18, m([0, [1, 2, 3]], [1, encodeCbor([4, -5])], [2, []], [7, [9]])],
      [19, [tag(30, [577, 10000]), tag(30, [721, 10000000])]],
      [20, [14000000, 10000000000]],
      [21, [62000000, 20000000000]],
      [25, [tag(30, [51, 100]), tag(30, [51, 100]), tag(30, [51, 100]), tag(30, [51, 100]), tag(30, [51, 100])]],
      [26, Array.from({ length: 10 }, () => tag(30, [67, 100]))],
      [33, tag(30, [15, 1])],
      [99, [1, 2]],
      [7, "weird"],
    );
    const proposals = [
      [0, prev, ppu, KEY],
      [1, null, [11, 0]],
      [2, m([REWARD, 5000]), null],
      [3, prev],
      [4, prev, set([cred()]), m([cred(1), 700]), tag(30, [2, 3])],
      [5, null, [ANCHOR, null]],
      [6],
      [42, "future"],
    ].map((a) => [100000000000, REWARD, a, ANCHOR]);
    const { tx, block } = one([[20, set(proposals as CborEncodable[])]]);
    const actions = tx.proposalProcedures!.map((p) => p.govAction);
    expect(actions.map((a) => a.type)).toEqual([
      "parameterChange",
      "hardForkInitiation",
      "treasuryWithdrawals",
      "noConfidence",
      "updateCommittee",
      "newConstitution",
      "info",
      "unknown",
    ]);
    expect(actions[0]).toMatchObject({
      prevActionId: { txId: "99".repeat(32), index: 3, id: expect.stringMatching(/^gov_action1/) },
      policyHash: KEYHEX,
      update: {
        minFeeA: 44n,
        minFeeB: 155381n,
        poolPledgeInfluence: { numerator: 3n, denominator: 10n },
        decentralization: { numerator: 1n, denominator: 2n },
        extraEntropy: { type: "nonce", hash: "07".repeat(32) },
        protocolVersion: { major: 9, minor: 1 },
        coinsPerUtxoByte: 4310n,
        costModels: { plutusV1: [1n, 2n, 3n], plutusV2: [4n, -5n], plutusV3: [], language7: [9n] },
        executionPrices: { memory: { numerator: 577n, denominator: 10000n }, steps: { numerator: 721n, denominator: 10000000n } },
        maxTxExUnits: { memory: 14000000n, steps: 10000000000n },
        maxBlockExUnits: { memory: 62000000n, steps: 20000000000n },
        poolVotingThresholds: { motionNoConfidence: { numerator: 51n }, ppSecurityGroup: { denominator: 100n } },
        drepVotingThresholds: { treasuryWithdrawal: { numerator: 67n } },
        minFeeRefScriptCostPerByte: { numerator: 15n, denominator: 1n },
        unknown_99: { cbor: "820102" },
        maxEpoch: { cbor: "weird" },
      },
    });
    expect(actions[1]).toEqual({ type: "hardForkInitiation", prevActionId: null, protocolVersion: { major: 11, minor: 0 } });
    expect(actions[2]).toMatchObject({ withdrawals: [{ amount: 5000n, rewardAccount: { bech32: expect.stringMatching(/^stake1/) } }], policyHash: null });
    expect(actions[4]).toMatchObject({ removed: [{ type: "key" }], added: [{ credential: { type: "script" }, expiresEpoch: 700n }], quorum: { numerator: 2n } });
    expect(actions[5]).toMatchObject({ constitution: { scriptHash: null, anchor: { url: "https://example.org/a.json" } } });
    expect(actions[7]).toMatchObject({ type: "unknown", tag: 42 });
    expect(block.warnings.join("\n")).toMatch(/unknown protocol parameter key 99/);
    expect(block.warnings.join("\n")).toMatch(/unknown governance action type 42/);
    expect(block.warnings.join("\n")).toMatch(/unexpected value for protocol parameter 7/);
  });

  it("decodes voting procedures for every voter role", () => {
    const gid = [b(32, 0x12), 0];
    const votes = m(
      [[0, KEY], m([gid, [0, null]])],
      [[1, KEY], m([gid, [1, ANCHOR]])],
      [[2, KEY], m([gid, [2, null]])],
      [[3, KEY], m([gid, [1, null]])],
      [[4, KEY], m([gid, [0, null]])],
    );
    const { tx } = one([[19, votes]]);
    expect(tx.votingProcedures!.map((v) => [v.voter.role, v.voter.id.split("1")[0], v.votes[0]!.vote])).toEqual([
      ["constitutionalCommitteeHotKey", "cc_hot", "no"],
      ["constitutionalCommitteeHotScript", "cc_hot", "yes"],
      ["drepKey", "drep", "abstain"],
      ["drepScript", "drep", "yes"],
      ["stakePoolKey", "pool", "no"],
    ]);
    expect(tx.votingProcedures![1]!.votes[0]!.anchor).toEqual({ url: "https://example.org/a.json", dataHash: "44".repeat(32) });
    expect(() => decodeBlock(buildBlock({ bodies: [body([[19, m([[5, KEY], m()])]])], witnesses: [m()] }))).toThrow(/unknown voter type 5/);
    expect(() => decodeBlock(buildBlock({ bodies: [body([[19, m([[2, KEY], m([gid, [3, null]])])]])], witnesses: [m()] }))).toThrow(/unknown vote 3/);
  });
});

describe("synthetic blocks: bodies, outputs, witnesses, auxiliary data", () => {
  it("decodes every transaction body field", () => {
    const policy = b(28, 0x88);
    const { tx, block } = one([
      [3, 5000],
      [5, m([REWARD, 77])],
      [7, b(32, 1)],
      [8, 100],
      [9, m([policy, m([Uint8Array.of(0x41), 5], [new Uint8Array(), -3], [Uint8Array.of(0xff, 0x00), 1])])],
      [11, b(32, 2)],
      [13, set([input(1)])],
      [14, set([KEY])],
      [15, 1],
      [16, [ENT_ADDR, 10]],
      [17, 20],
      [18, set([input(2)])],
      [21, 123456],
      [22, 789],
      [23, "future field"],
    ]);
    expect(tx).toMatchObject({
      ttl: 5000n,
      validityStart: 100n,
      withdrawals: [{ amount: 77n }],
      auxiliaryDataHash: "01".repeat(32),
      scriptDataHash: "02".repeat(32),
      collateral: [{ index: 1 }],
      requiredSigners: [KEYHEX],
      networkId: 1,
      collateralReturn: { index: 0, value: { lovelace: 10n }, format: "legacy" },
      totalCollateral: 20n,
      referenceInputs: [{ txId: "aa".repeat(32), index: 2 }],
      currentTreasuryValue: 123456n,
      donation: 789n,
      unknownFields: [{ key: 23, cbor: toHex(encodeCbor("future field")) }],
    });
    expect(tx.mint!.map((a) => [a.assetName, a.assetNameUtf8, a.quantity])).toEqual([
      ["41", "A", 5n],
      ["", undefined, -3n],
      ["ff00", undefined, 1n],
    ]);
    // The aux data hash does not match (there is no aux data).
    expect(block.integrity.auxiliaryDataHashesValid).toBe(false);
    expect(block.warnings.join()).toMatch(/unknown transaction body key 23/);
  });

  it("decodes all output encodings", () => {
    const datum = tag(121, [42, Uint8Array.of(1)]);
    const datumCbor = encodeCbor(datum);
    const native = [0, KEY];
    const nativeCbor = encodeCbor(native);
    const outputs = [
      [ENT_ADDR, [2000000, m([b(28, 9), m([Uint8Array.of(0x61), 1])])], b(32, 5)],
      m([0, ENT_ADDR], [1, 1500000], [2, [0, b(32, 6)]]),
      m([0, ENT_ADDR], [1, 1500000], [2, [1, tag(24, datumCbor)]], [3, tag(24, encodeCbor([0, native]))]),
      m([0, ENT_ADDR], [1, 1], [3, tag(24, encodeCbor([1, Uint8Array.of(1, 2)]))]),
      m([0, ENT_ADDR], [1, 1], [3, tag(24, encodeCbor([2, Uint8Array.of(3)]))]),
      m([0, ENT_ADDR], [1, 1], [3, tag(24, encodeCbor([9, Uint8Array.of(3)]))], [4, 0]),
      [encodeCbor([tag(24, Uint8Array.of(0x83, 0, 0xa0, 0)), 1]), 7],
    ];
    const blk = decodeBlock(buildBlock({ bodies: [m([0, [input()]], [1, outputs], [2, 1])], witnesses: [m()] })) as ShelleyBlock;
    const o = blk.transactions[0]!.outputs;
    expect(o[0]).toMatchObject({ format: "legacy", datumHash: "05".repeat(32), value: { lovelace: 2000000n, assets: [{ assetName: "61", assetNameUtf8: "a", quantity: 1n }] } });
    expect(o[1]).toMatchObject({ format: "map", datumHash: "06".repeat(32) });
    expect(o[2]!.inlineDatum).toEqual({ hash: toHex(blake2b256(datumCbor)), cbor: toHex(datumCbor), json: { constructor: 0, fields: [{ int: 42n }, { bytes: "01" }] } });
    expect(o[2]!.scriptRef).toMatchObject({ language: "native", hash: toHex(blake2b224(concatBytes([Uint8Array.of(0), nativeCbor]))), script: { type: "sig", keyHash: KEYHEX } });
    expect(o[3]!.scriptRef).toMatchObject({ language: "plutusV1", hash: toHex(blake2b224(Uint8Array.of(1, 1, 2))), size: 2 });
    expect(o[4]!.scriptRef).toMatchObject({ language: "plutusV2" });
    expect(o[5]!.scriptRef).toMatchObject({ language: "unknown", languageId: 9 });
    expect(o[6]!.address.type).toBe("byron");
    expect(blk.transactions[0]!.outputLovelace).toBe(2000000n + 3000000n + 3n + 7n);
    expect(blk.warnings.join()).toMatch(/unknown output key 4/);
    expect(blk.warnings.join()).toMatch(/unknown script language 9/);
    const badDatum = buildBlock({ bodies: [m([0, [input()]], [1, [m([0, ENT_ADDR], [1, 1], [2, [5, 1]])]], [2, 1])], witnesses: [m()] });
    expect(() => decodeBlock(badDatum)).toThrow(/unknown datum option 5/);
    const noAddr = buildBlock({ bodies: [m([0, [input()]], [1, [m([1, 1])]], [2, 1])], witnesses: [m()] });
    expect(() => decodeBlock(noAddr)).toThrow(/requires keys 0/);
    const missingFee = buildBlock({ bodies: [m([0, [input()]], [1, []])], witnesses: [m()] });
    expect(() => decodeBlock(missingFee)).toThrow(/fee/);
  });

  it("decodes witness sets of every kind and Plutus data encodings", () => {
    const natives = [
      [0, KEY],
      [1, [[0, KEY]]],
      [2, [[4, 10], [5, 20]]],
      [3, 1, [[0, KEY], [0, KEY]]],
    ];
    const datums = [
      tag(1280, [1]),
      tag(102, [500, []]),
      tag(2, Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 0)),
      tag(3, Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 0)),
      m([Uint8Array.of(1), [1, 2]]),
      -7,
    ];
    const wits = m(
      [0, set([[b(32, 0x10), b(64, 0x20)]])],
      [1, set(natives)],
      [2, set([[b(32), b(64), b(32), Uint8Array.of(0xa0)]])],
      [3, set([Uint8Array.of(0x4d, 1)])],
      [4, set(datums)],
      [5, m([[0, 0], [tag(121, []), [1, 2]]], [[1, 1], [0, [3, 4]]], [[2, 0], [0, [0, 0]]], [[3, 0], [0, [0, 0]]], [[4, 0], [0, [0, 0]]], [[5, 0], [0, [0, 0]]], [[9, 0], [0, [0, 0]]])],
      [6, set([Uint8Array.of(2)])],
      [7, set([Uint8Array.of(3)])],
      [9, "?"],
    );
    const { tx, block } = one([], wits);
    const w = tx.witnesses;
    expect(w.vkeys).toEqual([{ vkey: "10".repeat(32), keyHash: toHex(blake2b224(b(32, 0x10))), signature: "20".repeat(64) }]);
    expect(w.scripts.map((s) => s.language)).toEqual(["native", "native", "native", "native", "plutusV1", "plutusV2", "plutusV3"]);
    expect((w.scripts[0] as { hash: string }).hash).toBe(toHex(blake2b224(concatBytes([Uint8Array.of(0), encodeCbor(natives[0]!)]))));
    expect(w.scripts.map((s) => (s.language === "native" ? s.script.type : null))).toEqual(["sig", "all", "any", "atLeast", null, null, null]);
    expect(w.scripts[2]).toMatchObject({ script: { scripts: [{ type: "after", slot: 10n }, { type: "before", slot: 20n }] } });
    expect(w.scripts[3]).toMatchObject({ script: { required: 1n } });
    expect(w.bootstraps).toEqual([{ vkey: "01".repeat(32), signature: "01".repeat(64), chainCode: "01".repeat(32), attributes: "a0" }]);
    const expectedDatums: unknown[] = [
      { constructor: 7, fields: [{ int: 1n }] },
      { constructor: 500, fields: [] },
      { int: 2n ** 64n },
      { int: -1n - 2n ** 64n },
      { map: [{ k: { bytes: "01" }, v: { list: [{ int: 1n }, { int: 2n }] } }] },
      { int: -7n },
    ];
    expect(w.datums.map((d) => d.json)).toEqual(expectedDatums);
    for (const d of w.datums) expect(d.hash).toBe(toHex(blake2b256(Uint8Array.from(Buffer.from(d.cbor, "hex")))));
    expect(w.redeemers.map((r) => r.tag)).toEqual(["spend", "mint", "cert", "reward", "vote", "propose", "unknown"]);
    expect(w.redeemers[0]).toMatchObject({ index: 0, data: { constructor: 0, fields: [] }, dataCbor: "d87980", exUnits: { memory: 1n, steps: 2n } });
    expect(w.unknown).toEqual([{ key: 9, cbor: "613f" }]);
    expect(block.warnings.join()).toMatch(/unknown witness set key 9/);
  });

  it("decodes legacy (array) redeemers", () => {
    const { tx } = one([], m([5, [[0, 2, 7, [10, 20]]]]));
    expect(tx.witnesses.redeemers).toEqual([{ tag: "spend", tagId: 0, index: 2, data: { int: 7n }, dataCbor: "07", exUnits: { memory: 10n, steps: 20n } }]);
  });

  it("rejects invalid Plutus data and native scripts", () => {
    expect(() => one([], m([4, [tag(99, 1)]]))).toThrow(/unexpected tag 99/);
    expect(() => one([], m([4, [tag(102, [1])]]))).toThrow(/tag 102/);
    expect(() => one([], m([4, [tag(121, 5)]]))).toThrow(/fields must be an array/);
    expect(() => one([], m([4, ["text"]]))).toThrow(/invalid Plutus data/);
    expect(() => one([], m([1, [[6, 1]]]))).toThrow(/unknown native script type 6/);
  });

  it("decodes auxiliary data in all three formats and checks its hash", () => {
    const meta = m(
      [674, m(["msg", ["hello", "world"]])],
      [1, -5],
      [2, Uint8Array.of(0xde, 0xad)],
      [3, [m([1, 2])]],
      [4, tag(2, Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0, 0))],
    );
    const formats: CborEncodable[] = [meta, [meta, [[0, KEY]]], tag(259, m([0, meta], [1, [[0, KEY]]], [2, [Uint8Array.of(1)]], [3, [Uint8Array.of(2)]], [4, [Uint8Array.of(3)]], [9, 0]))];
    for (const [i, aux] of formats.entries()) {
      const auxHash = blake2b256(encodeCbor(aux));
      const blk = decodeBlock(buildBlock({ bodies: [body([[7, auxHash]])], witnesses: [m()], aux: m([0, aux]) }), { includeCbor: true }) as ShelleyBlock;
      const a = blk.transactions[0]!.auxiliaryData!;
      expect(a.format).toBe(["shelley", "shelley-ma", "alonzo"][i]);
      expect(a.hash).toBe(toHex(auxHash));
      expect(a.cbor).toBe(toHex(encodeCbor(aux)));
      expect(blk.integrity.auxiliaryDataHashesValid).toBe(true);
      expect(a.metadata).toEqual([
        { label: 674n, value: { map: [{ k: { string: "msg" }, v: { list: [{ string: "hello" }, { string: "world" }] } }] } },
        { label: 1n, value: { int: -5n } },
        { label: 2n, value: { bytes: "dead" } },
        { label: 3n, value: { list: [{ map: [{ k: { int: 1n }, v: { int: 2n } }] }] } },
        { label: 4n, value: { int: 2n ** 64n } },
      ]);
      expect(a.scripts.length).toBe([0, 1, 4][i]);
      if (i === 2) expect(blk.warnings.join()).toMatch(/unknown auxiliary data key 9/);
    }
    expect(() => decodeBlock(buildBlock({ bodies: [body()], witnesses: [m()], aux: m([0, "nope"]) }))).toThrow(/auxiliary data encoding/);
    expect(() => decodeBlock(buildBlock({ bodies: [body()], witnesses: [m()], aux: m([0, m([1, true])]) }))).toThrow(/invalid metadatum/);
    const orphan = decodeBlock(buildBlock({ bodies: [body()], witnesses: [m()], aux: m([5, m()]) }));
    expect(orphan.warnings.join()).toMatch(/non-existent transaction 5/);
  });
});

describe("synthetic blocks: block structure", () => {
  it("marks invalid transactions and excludes them from totals", () => {
    const blk = decodeBlock(buildBlock({ bodies: [body(), body([[3, 1]])], witnesses: [m(), m()], invalid: [1, 7] })) as ShelleyBlock;
    expect(blk.transactions.map((t) => t.valid)).toEqual([true, false]);
    expect(blk.invalidTransactions).toEqual([1, 7]);
    expect(blk.stats).toMatchObject({ transactionCount: 2, invalidTransactionCount: 1, totalFees: 170000n, totalOutputLovelace: 1000000n });
    expect(blk.warnings.join()).toMatch(/invalid transaction index 7 out of range/);
  });

  it("decodes TPraos (Shelley-era) structure without the invalid list", () => {
    const blk = decodeBlock(buildBlock({ eraTag: 2, praos: false, invalid: null, bodies: [body()], witnesses: [m()] })) as ShelleyBlock;
    expect(blk.era).toBe("shelley");
    expect(blk.header.prevHash).toBeNull();
    expect(blk.integrity.bodyHashValid).toBe(true);
    expect(blk.transactions[0]!.size).toBe(1 + encodeCbor(body()).length + 1 + 1);
  });

  it("decodes a future era tag with Conway rules and a warning", () => {
    const blk = decodeBlock(buildBlock({ eraTag: 8, bodies: [], witnesses: [] }));
    expect(blk.era).toBe("unknown");
    expect(blk.eraTag).toBe(8);
    expect(blk.warnings).toEqual([expect.stringMatching(/unknown era tag 8/)]);
  });

  it("flags a tampered body via the body hash", () => {
    const bytes = buildBlock({ bodies: [body()], witnesses: [m()] });
    const fee = encodeCbor(170000);
    const at = Buffer.from(bytes).indexOf(Buffer.from(fee));
    const tampered = Uint8Array.from(bytes);
    tampered[at + fee.length - 1] = tampered[at + fee.length - 1]! ^ 1;
    const blk = decodeBlock(tampered) as ShelleyBlock;
    expect(blk.integrity.bodyHashValid).toBe(false);
    expect(blk.integrity.bodySizeValid).toBe(true);
  });

  it("rejects structurally invalid blocks", () => {
    const err = (bytes: Uint8Array | string): string => {
      try {
        decodeBlock(bytes);
      } catch (e) {
        return `${(e as { code: string }).code}: ${(e as Error).message}`;
      }
      return "ok";
    };
    expect(err(encodeCbor([99, []]))).toMatch(/BLOCK_DECODE: block: unknown era tag 99/);
    expect(err(encodeCbor(5))).toMatch(/BLOCK_DECODE: block: expected array/);
    expect(err(new Uint8Array())).toMatch(/CBOR_DECODE: empty input/);
    expect(err("abc")).toMatch(/INVALID_ARGUMENT/);
    expect(err(42 as never)).toMatch(/INVALID_ARGUMENT/);
    expect(err(buildBlock({ bodies: [body()], witnesses: [] }))).toMatch(/1 transaction bodies but 0 witness sets/);
    expect(err(buildBlock({ bodies: [], witnesses: [], headerBody: [1, 2, 3] }))).toMatch(/expected 10 \(Praos\) or 15 \(TPraos\) fields/);
    expect(err(encodeCbor([7, [1, 2, 3]]))).toMatch(/BLOCK_DECODE/);
    expect(err(encodeCbor([7, [1, 2, 3, 4, 5, 6]]))).toMatch(/expected 4 or 5 elements/);
    const ok = buildBlock({ bodies: [body()], witnesses: [m()] });
    expect(err(ok.subarray(0, ok.length - 3))).toMatch(/CBOR_DECODE: .*unexpected end|CBOR_DECODE: declared length/);
    expect(err(concatBytes([ok, Uint8Array.of(0)]))).toMatch(/trailing/);
    expect(() => decodeBlock(ok, { maxDepth: 3 })).toThrow(/depth/);
  });
});
