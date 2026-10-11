import { afterEach, describe, expect, it } from "vitest";
import { fetchBlock, fetchRawBlock, isCardanoBlockError, toJson, type ShelleyBlock } from "../src/index.js";
import { blockPoint } from "../src/block.js";
import { fixture } from "./helpers/fixtures.js";
import { startMockRelay, type Behaviour, type MockRelay } from "./helpers/mock-relay.js";

const votes = fixture("conway-preprod-votes");
const empty = fixture("conway-preprod-empty");
const byron = fixture("byron-mainnet");
const vp = blockPoint(votes);

let relay: MockRelay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

async function start(behaviour: Behaviour = "ok", versions?: number[]): Promise<MockRelay> {
  relay = await startMockRelay({ magic: 1, blocks: [votes, empty, byron], behaviour, ...(versions ? { versions } : {}) });
  return relay;
}

const base = (r: MockRelay, extra: Record<string, unknown> = {}) => ({
  relay: `127.0.0.1:${r.port}`,
  point: { slot: vp.slot, hash: vp.hash },
  network: "preprod" as const,
  allowPrivateAddresses: true,
  timeoutMs: 3000,
  ...extra,
});

async function settle(r: MockRelay, n: number): Promise<void> {
  for (let i = 0; i < 100 && r.received.length < n; i++) await new Promise((x) => setTimeout(x, 10));
}

async function expectCode(p: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(isCardanoBlockError(err)).toBe(true);
    expect((err as { code: string }).code).toBe(code);
    if (message) expect((err as Error).message).toMatch(message);
    return;
  }
  throw new Error(`expected rejection with ${code}`);
}

describe("fetchBlock over a mock relay", () => {
  it("negotiates, fetches and decodes a block", async () => {
    const r = await start();
    const block = (await fetchBlock(base(r))) as ShelleyBlock;
    expect(block.hash).toBe(vp.hash);
    expect(block.slot).toBe(vp.slot);
    expect(block.era).toBe("conway");
    expect(block.transactions).toHaveLength(3);
    expect(JSON.parse(JSON.stringify(toJson(block)))).toMatchObject({ slot: vp.slot.toString() });
    // Client spoke in initiator mode only: handshake, request range, client done.
    await settle(r, 3);
    expect(r.modes.every((m) => (m & 0x8000) === 0)).toBe(true);
    expect(r.received.map((m) => m.protocol)).toEqual([0, 3, 3]);
  });

  it("proposes v14, v15 and v16 with the right version data", async () => {
    const r = await start("ok", [14, 15, 16]);
    const raw = await fetchRawBlock(base(r));
    await settle(r, 3);
    expect(raw.version).toBe(16);
    expect(raw.address).toBe("127.0.0.1");
    const propose = r.received[0]!.item as [bigint, { entries: Array<[bigint, unknown[]]> }];
    expect(propose[0]).toBe(0n);
    const table = propose[1].entries;
    expect(table.map(([k]) => k)).toEqual([14n, 15n, 16n]);
    expect(table[0]![1]).toEqual([1n, true, 0n, false]);
    expect(table[2]![1]).toEqual([1n, true, 0n, false, false]);
    const request = r.received[1]!.item as unknown[];
    expect(request[0]).toBe(0n);
    expect(r.received[2]!.item).toEqual([1n]);
  });

  it("accepts the point as a string and slot as string/number", async () => {
    const r = await start();
    expect((await fetchRawBlock(base(r, { point: `${vp.slot}.${vp.hash}` }))).cbor).toEqual(votes);
    expect((await fetchRawBlock(base(r, { point: { slot: String(vp.slot), hash: vp.hash.toUpperCase() } }))).cbor).toEqual(votes);
    expect((await fetchRawBlock(base(r, { point: { slot: Number(vp.slot), hash: vp.hash }, relay: { host: "127.0.0.1", port: r.port } }))).point.slot).toBe(vp.slot);
  });

  it("fetches a Byron block and an empty block", async () => {
    const r = await start();
    const bp = blockPoint(byron);
    const b = await fetchBlock(base(r, { point: { slot: bp.slot, hash: bp.hash } }));
    expect(b.era).toBe("byron");
    const ep = blockPoint(empty);
    const e = await fetchBlock(base(r, { point: { slot: ep.slot, hash: ep.hash }, includeCbor: true }));
    expect(e.transactions).toHaveLength(0);
    expect(e.cbor).toBeTypeOf("string");
  });

  it("handles messages split across many SDUs and TCP segments", async () => {
    const r = await start("trickle");
    const raw = await fetchRawBlock(base(r));
    expect(raw.cbor).toEqual(votes);
  });

  it("ignores responder traffic on other mini-protocols", async () => {
    const r = await start("keepalive-noise");
    expect((await fetchRawBlock(base(r))).cbor).toEqual(votes);
  });

  it("accepts an untagged MsgBlock payload", async () => {
    const r = await start("untagged-block");
    expect((await fetchRawBlock(base(r))).cbor).toEqual(votes);
  });

  it("reports MsgNoBlocks clearly", async () => {
    const r = await start();
    await expectCode(fetchBlock(base(r, { point: { slot: vp.slot + 1n, hash: vp.hash } })), "NO_BLOCKS", /no block at slot/);
    const r2 = relay!;
    expect(r2.received.at(-1)!.protocol).toBe(3);
  });

  it("rejects a block that does not match the requested point", async () => {
    const r = await start("wrong-block");
    await expectCode(fetchBlock(base(r)), "BLOCK_MISMATCH", /expected/);
  });

  it("reports a wrong network magic as a refused handshake", async () => {
    const r = await start();
    await expectCode(fetchBlock(base(r, { network: "mainnet" })), "HANDSHAKE_REFUSED", /764824073/);
  });

  it("reports version mismatches", async () => {
    const r = await start("refuse-version");
    await expectCode(fetchBlock(base(r)), "HANDSHAKE_REFUSED", /version mismatch.*99, 100/);
    const r2 = await startMockRelay({ magic: 1, blocks: [votes], versions: [13] });
    try {
      await expectCode(fetchBlock(base(r2)), "HANDSHAKE_REFUSED", /\[13\]/);
    } finally {
      await r2.close();
    }
  });

  it("rejects an accept for a different magic or an unproposed version", async () => {
    let r = await start("accept-wrong-magic");
    await expectCode(fetchBlock(base(r)), "HANDSHAKE_REFUSED", /network magic 2/);
    await r.close();
    r = await start("accept-unproposed");
    await expectCode(fetchBlock(base(r)), "PROTOCOL", /not proposed/);
  });

  it("detects protocol violations", async () => {
    for (const [b, re] of [
      ["two-blocks", /more than one block/],
      ["batch-done-without-block", /without a block/],
      ["initiator-traffic", /initiator-mode/],
      ["query-reply", /MsgQueryReply/],
      ["garbage", /./],
    ] as const) {
      const r = await start(b);
      await expectCode(fetchBlock(base(r)), b === "garbage" ? "PROTOCOL" : "PROTOCOL", re);
      await r.close();
      relay = undefined;
    }
  });

  it("reports an early close", async () => {
    const r = await start("close-after-handshake");
    // The mock closes right after accepting; depending on timing the block request may already be sent.
    const p = fetchBlock(base(r, { point: { slot: vp.slot, hash: "00".repeat(32) } }));
    await expect(p).rejects.toSatisfy((e: unknown) => isCardanoBlockError(e, "CONNECTION") || isCardanoBlockError(e, "NO_BLOCKS"));
  });

  it("times out on a silent relay", async () => {
    const r = await start("silent");
    const t0 = Date.now();
    await expectCode(fetchBlock(base(r, { timeoutMs: 200 })), "TIMEOUT", /handshake/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("honours an AbortSignal", async () => {
    const r = await start("silent");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expectCode(fetchBlock(base(r, { signal: ac.signal })), "ABORTED");
    const pre = new AbortController();
    pre.abort();
    await expectCode(fetchBlock(base(r, { signal: pre.signal })), "ABORTED");
  });

  it("reports connection refused", async () => {
    const r = await start();
    const port = r.port;
    await r.close();
    relay = undefined;
    await expectCode(fetchBlock({ ...base(r), relay: `127.0.0.1:${port}` }), "CONNECTION", /ECONNREFUSED|failed/);
  });

  it("refuses private addresses unless allowed", async () => {
    const r = await start();
    await expectCode(fetchBlock({ ...base(r), allowPrivateAddresses: false }), "INVALID_ARGUMENT", /non-public/);
    await expectCode(fetchBlock({ ...base(r), relay: `localhost:${r.port}`, allowPrivateAddresses: undefined }), "INVALID_ARGUMENT", /allowPrivateAddresses/);
    expect(r.received).toHaveLength(0);
  });

  it("reports DNS failures", async () => {
    const err = await fetchBlock({ relay: "does-not-exist.invalid:3001", point: { slot: 1, hash: "00".repeat(32) }, timeoutMs: 5000 }).catch(
      (e: unknown) => e,
    );
    // Some sandboxed resolvers answer every name with a non-public placeholder address, which the
    // private-address guard then rejects; both outcomes mean "not connected".
    expect(isCardanoBlockError(err, "CONNECTION") || isCardanoBlockError(err, "INVALID_ARGUMENT")).toBe(true);
  });

  it("validates options before connecting", async () => {
    const r = await start();
    await expectCode(fetchBlock(base(r, { timeoutMs: 0 })), "INVALID_ARGUMENT", /timeoutMs/);
    await expectCode(fetchBlock(base(r, { maxBlockBytes: 10 })), "INVALID_ARGUMENT", /maxBlockBytes/);
    await expectCode(fetchBlock(base(r, { versions: [7] })), "INVALID_ARGUMENT", /versions/);
    await expectCode(fetchBlock(base(r, { point: vp.hash })), "INVALID_ARGUMENT", /hash alone/);
    await expectCode(fetchBlock(base(r, { point: { hash: vp.hash } })), "INVALID_ARGUMENT", /slot is required/);
    await expectCode(fetchBlock(base(r, { network: "sanchonet" })), "INVALID_ARGUMENT", /unknown network/);
    await expectCode(fetchBlock(null as never), "INVALID_ARGUMENT");
    expect(r.received).toHaveLength(0);
  });

  it("enforces maxBlockBytes", async () => {
    const r = await start();
    await expectCode(fetchBlock(base(r, { maxBlockBytes: 2048 })), "PROTOCOL", /exceeds/);
  });
});
