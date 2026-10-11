# cardano-block-json

[![CI](https://github.com/gildor853/cardano-block-json/actions/workflows/ci.yml/badge.svg)](https://github.com/gildor853/cardano-block-json/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)

Provided as is, without warranty — see [DISCLAIMER.md](./DISCLAIMER.md).

Give it a **block point and a Cardano relay** (`host:port`); get back **one
structured JSON document with everything that happened in that block**:
header, every transaction, inputs, outputs and native assets, certificates,
withdrawals, minting, protocol updates, Conway governance (proposals, votes,
DReps, committee), scripts, datums, redeemers and metadata — plus derived
values such as transaction ids, bech32 addresses, pool / DRep / governance
action ids, asset fingerprints and hash checks.

It speaks the Ouroboros **node-to-node** protocol directly (mux, handshake,
BlockFetch) over TCP, so it works against any public relay or your own node
without db-sync, Ogmios, Blockfrost or an API key. Zero runtime dependencies;
Node.js only for fetching, decoding also works in any JavaScript runtime.

## Why

- **One call, all the data**: `fetchBlock()` returns a fully decoded block;
  nothing is summarised away. Unknown or future fields are kept as raw CBOR and
  reported in `warnings` instead of being dropped.
- **Every era**: Byron (main and epoch-boundary blocks), Shelley, Allegra, Mary,
  Alonzo, Babbage and Conway.
- **Self-checking**: the header hash is recomputed and must match the
  requested point, and the body hash / body size from the header are verified
  against the transactions actually received.
- **Safe by default**: strict timeouts, size limits, depth limits and an SSRF
  guard that refuses private/loopback relay addresses unless you opt in.
- **Tested on real chain data**: the decoder was run over tens of thousands of
  real mainnet, preprod and preview blocks of every era, and decoded fields were
  cross-checked against an independent chain indexer.

## Install

Not published to npm yet. Install a tagged release from GitHub (npm builds
the package during installation):

```sh
npm install github:gildor853/cardano-block-json#v1.0.0
```

Requires Node.js 18+. The published package has no runtime dependencies and is
verified on Node.js 18 and 20 by a runtime smoke test in CI. Development
(tests) needs Node.js 22.12+, as required by vitest 5.

## Quick start

<!-- readme-check: skip (needs network access to a relay) -->
```ts
import { fetchBlock, stringifyBlock } from "cardano-block-json";

const block = await fetchBlock({
  relay: "backbone.cardano.iog.io:3001",
  point: {
    slot: 143212791,
    hash: "ac8038e5538582f8721a49858ded4f12ae8987b3aca1eab9beed65c9f64e50a1",
  },
  network: "mainnet",
});

console.log(block.era, block.transactions.length); // "conway" 42
console.log(stringifyBlock(block));                // pretty JSON, big integers as strings
```

### A block is addressed by its point (slot + hash)

The node-to-node protocol fetches blocks by **point**: the block's slot *and*
its header hash. A hash alone cannot be requested from a relay, so the library
rejects it with an `INVALID_ARGUMENT` error that asks for the slot — it never
guesses one. Explorers, db-sync, Koios and Blockfrost show the slot next to
every block hash. Points can be given as `{ slot, hash }` or as the string
`"<slot>.<hash>"`.

```ts
import { parsePoint } from "cardano-block-json";

parsePoint("143212791.ac8038e5538582f8721a49858ded4f12ae8987b3aca1eab9beed65c9f64e50a1").slot.toString(); // "143212791"
```

### Decoding CBOR you already have

`decodeBlock()` accepts the `[eraTag, block]` form returned by relays (and
stored in the node's ImmutableDB chunk files), the CBOR-in-CBOR wrapped form,
or a bare era block — as bytes or hex.

```ts
import { readFileSync } from "node:fs";
import { decodeBlock, isShelleyBlock, toJson } from "cardano-block-json";

const block = decodeBlock(readFileSync("test/fixtures/conway-mainnet-hardfork.cbor"));
if (!isShelleyBlock(block)) throw new Error("expected a Shelley-based block");

block.era;                        // "conway"
block.slot.toString();            // "143212791"
block.integrity.bodyHashValid;    // true

block.transactions[38]?.proposalProcedures?.[0]?.govAction.type; // "hardForkInitiation"

toJson(block.stats); // { transactionCount: 42, invalidTransactionCount: 0, totalFees: "11200434", ... }
```

## Output

Every block has `era`, `eraTag`, `hash`, `slot`, `blockNumber`, `size`,
`header` and `warnings`. Shelley-based blocks (Shelley … Conway) add:

| Field | Contents |
| --- | --- |
| `header` | Block number, slot, previous hash, issuer key, pool hash and `pool1…` id, VRF key and results (nonce/leader for TPraos, combined for Praos), body size and hash, operational certificate, protocol version, KES signature, header size. |
| `transactions[]` | `index`, `id`, `valid` (Plutus phase-2 result), `size` (as the ledger counts it for fees), inputs, outputs, fee, TTL / validity start, certificates, withdrawals, protocol updates, auxiliary data hash, mint, script data hash, collateral, required signers, network id, collateral return, total collateral, reference inputs, voting procedures, proposal procedures, treasury value, donation, witnesses and auxiliary data. Fields absent from the transaction are omitted. |
| outputs | Address (hex, bech32/base58, type, network, payment and stake credentials, pointer), value (`lovelace` + assets with policy id, hex name, UTF-8 name when printable and CIP-14 fingerprint), datum hash or inline datum (decoded), reference script (decoded, with hash), legacy/map encoding. |
| certificates | All 19 Shelley and Conway certificate types (stake registration/delegation, pool registration with relays and metadata, retirement, genesis delegation, MIR, DRep and committee certificates, combined Conway certificates), with bech32 pool ids and CIP-129 DRep / committee ids. |
| governance | Proposals with all seven action types (parameter change with named parameters, hard fork, treasury withdrawals, no confidence, committee update, constitution, info), previous action ids, anchors; votes by committee members, DReps and pools with CIP-129 voter and `gov_action…` ids. |
| witnesses | VKey witnesses (with key hash), bootstrap witnesses, native scripts (decoded tree), Plutus V1/V2/V3 scripts with hashes, datums (detailed-schema JSON + hash) and redeemers (purpose, index, data, execution units) in both array and map encodings. |
| auxiliary data | Transaction metadata (detailed-schema JSON, UTF-8 text when valid), auxiliary scripts, in Shelley, Shelley-MA and Alonzo formats. |
| `invalidTransactions` | Indices of transactions that failed phase-2 validation (their collateral was consumed instead). |
| `stats` | Transaction count, invalid count, total fees and output lovelace of valid transactions, total transaction size. |
| `integrity` | Recomputed body hash and body size and whether they match the header; whether every auxiliary data hash matches. |

Byron main blocks contain header (with epoch, slot in epoch and absolute
slot, issuer, signature), transactions (inputs, outputs with base58 addresses,
attributes, witnesses, ids and sizes) and the remaining body payloads (shared
seed, delegation, update) as raw CBOR. Epoch-boundary blocks contain the
epoch, previous hash, difficulty and the list of genesis-delegate key hashes.

Big integers (`slot`, lovelace amounts, …) are `bigint` in JavaScript.
`toJson()` / `stringifyBlock()` convert them to strings (default) or to numbers
when safe (`{ bigint: "number" }`). Plutus data and metadata use the
detailed JSON schema used by
`cardano-cli` (`constructor` / `fields`, `map`, `list`, `int`, `bytes`); test for
`"fields" in data` rather than reading `.constructor`, which every JavaScript
object has.

Pass `{ includeCbor: true }` to also get the raw CBOR (hex) of the block and of
each transaction body, witness set and auxiliary data.

### Era coverage

| Era | Decoding |
| --- | --- |
| Shelley, Allegra, Mary, Alonzo, Babbage, Conway | Complete: every field defined by the ledger CDDL is decoded and named. |
| Byron main blocks | Header, transactions and witnesses decoded; delegation, update and shared-seed payloads returned as raw CBOR. |
| Byron epoch-boundary blocks | Complete. |
| Future eras / unknown fields | Kept as raw CBOR, with a warning. |

The library does **not** validate signatures, VRF/KES proofs or ledger rules,
and it does not resolve inputs (values of spent outputs are not part of a block).

## API reference

| Function | Description |
| --- | --- |
| `fetchBlock(options)` | Fetches the block at `options.point` from `options.relay` and decodes it. Accepts every `DecodeBlockOptions` too. |
| `fetchRawBlock(options)` | Same, but returns `{ cbor, version, address, point }` without decoding. |
| `decodeBlock(input, options?)` | Decodes block CBOR (bytes or hex). |
| `isShelleyBlock(block)` | Type guard: `true` for Shelley … Conway blocks (which have `stats`, `integrity`, …), `false` for Byron. |
| `blockPoint(input)` | Returns `{ slot, hash, era }` of block CBOR without a full decode. |
| `toJson(value, { bigint })` / `stringifyBlock(value, { bigint, indent })` | JSON-safe conversion / string. |
| `decodeAddress(bytes)` | Decodes a Shelley or Byron address. |
| `parseRelay(text)`, `parsePoint(input)`, `networkMagic(network)`, `isPrivateAddress(ip)` | Input helpers. |
| `NETWORK_MAGIC`, `N2N_VERSIONS` | `{ mainnet: 764824073, preprod: 1, preview: 2 }`, proposed node-to-node versions. |

`fetchBlock` / `fetchRawBlock` options:

| Option | Default | |
| --- | --- | --- |
| `relay` | — | `"host:port"`, `"[ipv6]:port"` or `{ host, port }`. |
| `point` | — | `{ slot, hash }` or `"slot.hash"`. |
| `network` | `"mainnet"` | `"mainnet"`, `"preprod"`, `"preview"` or a numeric network magic. |
| `timeoutMs` | `30000` | Deadline for the whole request (connect, handshake, fetch). |
| `signal` | — | `AbortSignal` to cancel. |
| `allowPrivateAddresses` | `false` | Allow loopback/private/reserved addresses (needed for your own local node). |
| `maxBlockBytes` | 8 MiB | Upper bound for the received block. |

`decodeBlock` options: `includeCbor`, `era` (for bare blocks without the era
tag), `byronSlotsPerEpoch` (default 21600), `maxDepth` (default 256).

### Errors

Every failure is a `CardanoBlockError` with a `code`:

| Code | Meaning |
| --- | --- |
| `INVALID_ARGUMENT` | Bad relay, point (e.g. hash without slot), network or option; private address without opt-in. |
| `CONNECTION` | DNS failure, refused or reset connection. |
| `TIMEOUT` / `ABORTED` | Deadline exceeded / aborted by `signal`. |
| `HANDSHAKE_REFUSED` | The relay refused all versions or the network magic (wrong `network`). |
| `NO_BLOCKS` | The relay does not have a block at that point (wrong slot/hash, or rolled back). |
| `BLOCK_MISMATCH` | The relay returned a different block than requested. |
| `PROTOCOL` | The relay violated the protocol. |
| `CBOR_DECODE` / `BLOCK_DECODE` | Malformed CBOR / unexpected block structure (with the path in the message). |

```ts
import { decodeBlock, isCardanoBlockError } from "cardano-block-json";

let code = "";
try {
  decodeBlock("8100");
} catch (err) {
  if (isCardanoBlockError(err)) code = err.code;
}
code; // "BLOCK_DECODE"
```

## Command line

```sh
npx cardano-block-json --relay backbone.cardano.iog.io:3001 \
  --slot 143212791 --hash ac8038e5538582f8721a49858ded4f12ae8987b3aca1eab9beed65c9f64e50a1 > block.json

npx cardano-block-json --relay preprod-node.play.dev.cardano.org:3001 --network preprod --point <slot>.<hash>
npx cardano-block-json --file block.cbor          # decode a local block (binary or hex, "-" for stdin)
```

Options: `--network`, `--timeout <ms>`, `--raw` (print the block CBOR hex),
`--include-cbor`, `--bigint string|number`, `--compact`, `--public-only`
(refuse private addresses; by default the CLI allows them so you can query your
own node). Exit codes: `0` success, `1` error, `2` usage.

## Relays and networking

- Public relays (for example IOG's `backbone.cardano.iog.io:3001`, or relays of
  stake pools) are third-party services. They may rate-limit, refuse or drop
  connections, or lag behind; nothing guarantees a given relay serves old
  blocks quickly. For heavy use, run your own node and connect to it with
  `allowPrivateAddresses: true`.
- The client connects as an *initiator-only* peer: it offers no blocks, does no
  peer sharing, and closes the connection after one request.
- Outbound TCP to the relay port (usually 3001) must be allowed by your network.
- `allowPrivateAddresses` defaults to `false` so that relay strings coming from
  users cannot be used to probe internal hosts; the hostname is resolved once
  and the checked IP is the one connected to.

## Limitations

- A block is fetched by point; looking up the slot for a hash requires an
  indexer or chain-sync and is out of scope.
- Values of spent inputs are not in the block, so per-transaction balances
  (inputs minus outputs) cannot be computed without another data source.
- Cryptographic signatures, VRF and KES proofs and ledger rules are not
  verified; hash checks only ensure the data is internally consistent and
  matches the requested point.
- Byron delegation, update and shared-seed payloads are returned as raw CBOR.

## Disclaimer

This software is provided as is, without warranty of any kind. Decoded data
can be incomplete or wrong, and relays are third-party services outside the
author's control. Verify anything consequential independently. See
[DISCLAIMER.md](./DISCLAIMER.md) for the full disclaimer and limitation of
liability.

## License

[MIT](./LICENSE) © 2026 Gildor
