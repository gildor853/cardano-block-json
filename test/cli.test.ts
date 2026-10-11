import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli-main.js";
import { blockPoint } from "../src/block.js";
import { toHex } from "../src/bytes.js";
import { fixture } from "./helpers/fixtures.js";
import { startMockRelay, type MockRelay } from "./helpers/mock-relay.js";

const votes = fixture("conway-preprod-votes");
const vp = blockPoint(votes);
const files: Record<string, Uint8Array> = {
  "votes.cbor": votes,
  "votes.hex": new TextEncoder().encode(`${toHex(votes)}\n`),
  "votes.0x": new TextEncoder().encode(`0x${toHex(votes)}`),
  "junk.bin": Uint8Array.of(0xff, 0x00, 0x01),
};

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await runCli(argv, {
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
    readFile: (p) => {
      const f = files[p];
      if (!f) throw new Error(`ENOENT: no such file '${p}'`);
      return f;
    },
  });
  return { code, out, err };
}

let relay: MockRelay | undefined;
afterEach(async () => {
  await relay?.close();
  relay = undefined;
});

describe("cli: local files", () => {
  it("decodes binary, hex and 0x-hex files identically", async () => {
    const a = await run(["--file", "votes.cbor"]);
    const b = await run(["--file", "votes.hex"]);
    const c = await run(["--file", "votes.0x"]);
    expect(a.code).toBe(0);
    expect(a.err).toBe("");
    expect(b.out).toBe(a.out);
    expect(c.out).toBe(a.out);
    const json = JSON.parse(a.out);
    expect(json.era).toBe("conway");
    expect(json.slot).toBe(vp.slot.toString());
    expect(json.hash).toBe(vp.hash);
  });

  it("supports --compact, --bigint number and --include-cbor", async () => {
    const r = await run(["--file", "votes.cbor", "--compact", "--bigint", "number", "--include-cbor"]);
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toHaveLength(1);
    const json = JSON.parse(r.out);
    expect(typeof json.slot).toBe("number");
    expect(typeof json.cbor).toBe("string");
    expect(typeof json.transactions[0].cbor.body).toBe("string");
  });

  it("reports decode and file errors with exit code 1", async () => {
    const junk = await run(["--file", "junk.bin"]);
    expect(junk.code).toBe(1);
    expect(junk.err).toMatch(/^error \[(CBOR_DECODE|BLOCK_DECODE)\]/);
    const missing = await run(["--file", "nope.cbor"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/^error: ENOENT/);
  });
});

describe("cli: usage", () => {
  it("prints help and version", async () => {
    const h = await run(["--help"]);
    expect(h.code).toBe(0);
    expect(h.out).toMatch(/Usage:/);
    const v = await run(["-v"]);
    expect(v.code).toBe(0);
    expect(v.out.trim()).toMatch(/^(dev|\d+\.\d+\.\d+.*)$/);
  });

  it("rejects bad usage with exit code 2", async () => {
    expect((await run(["--bogus"])).code).toBe(2);
    expect((await run(["positional"])).code).toBe(2);
    expect((await run([])).code).toBe(2);
    expect((await run(["--file", "votes.cbor", "--bigint", "float"])).code).toBe(2);
    expect((await run(["--file", "votes.cbor", "--relay", "127.0.0.1:1"])).code).toBe(2);
  });

  it("explains that a hash alone is not enough", async () => {
    const r = await run(["--relay", "127.0.0.1:3001", "--hash", vp.hash]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/INVALID_ARGUMENT/);
    expect(r.err).toMatch(/slot/);
  });

  it("validates timeout, network and relay arguments", async () => {
    const pt = ["--slot", vp.slot.toString(), "--hash", vp.hash];
    expect((await run(["--relay", "127.0.0.1:3001", ...pt, "--timeout", "soon"])).err).toMatch(/INVALID_ARGUMENT/);
    expect((await run(["--relay", "127.0.0.1:3001", ...pt, "--network", "moonnet"])).err).toMatch(/INVALID_ARGUMENT/);
    expect((await run(["--relay", "http://relay:3001", ...pt])).err).toMatch(/INVALID_ARGUMENT/);
    expect((await run(["--relay", "127.0.0.1:3001", ...pt, "--public-only"])).err).toMatch(/INVALID_ARGUMENT/);
  });
});

describe("cli: fetching from a relay", () => {
  it("fetches and prints a block (slot + hash, --point, numeric network, --raw)", async () => {
    relay = await startMockRelay({ magic: 1, blocks: [votes] });
    const r = `127.0.0.1:${relay.port}`;
    const a = await run(["--relay", r, "--slot", vp.slot.toString(), "--hash", vp.hash, "--network", "preprod", "--timeout", "5000"]);
    expect(a.err).toBe("");
    expect(a.code).toBe(0);
    expect(JSON.parse(a.out).hash).toBe(vp.hash);
    const b = await run(["--relay", r, "--point", `${vp.slot}.${vp.hash}`, "--network", "1"]);
    expect(b.out).toBe(a.out);
    const raw = await run(["--relay", r, "--point", `${vp.slot}.${vp.hash}`, "--network", "preprod", "--raw"]);
    expect(raw.out.trim()).toBe(toHex(votes));
  });

  it("reports relay errors", async () => {
    relay = await startMockRelay({ magic: 1, blocks: [votes] });
    const r = await run(["--relay", `127.0.0.1:${relay.port}`, "--point", `${vp.slot}.${vp.hash}`]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/HANDSHAKE_REFUSED/);
  });
});
