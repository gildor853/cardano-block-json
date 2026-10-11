# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-11

- Fetch a block by point (slot + hash) from any Cardano relay over the node-to-node protocol (handshake + BlockFetch) on mainnet, preprod, preview or a custom network.
- Decode blocks of every era (Byron, Shelley, Allegra, Mary, Alonzo, Babbage, Conway) into structured, JSON-ready objects: header, transactions, outputs and assets, certificates, withdrawals, protocol updates, Conway governance (proposals, votes, DReps, committee), scripts, datums, redeemers and metadata.
- Derived data: transaction ids and sizes, addresses (bech32 / base58), pool and DRep ids, asset fingerprints, script and datum hashes, block statistics and header/body hash checks.
- `npx cardano-block-json` command-line tool for relays and local CBOR files.
- Zero runtime dependencies; ESM and CJS builds with TypeScript types.

[Unreleased]: https://github.com/gildor853/cardano-block-json/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/gildor853/cardano-block-json/releases/tag/v1.0.0
