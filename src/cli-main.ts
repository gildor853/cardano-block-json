// Command-line interface logic: fetch a block from a relay (or decode a local CBOR file) and print JSON.
import { parseArgs } from "node:util";
import { decodeBlock } from "./block.js";
import { CardanoBlockError } from "./errors.js";
import { stringifyBlock } from "./json.js";
import { fetchRawBlock, type FetchBlockOptions } from "./network/client.js";
import { toHex } from "./bytes.js";

declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

const USAGE = `Usage:
  cardano-block-json --relay <host:port> --slot <slot> --hash <hash> [options]
  cardano-block-json --relay <host:port> --point <slot>.<hash> [options]
  cardano-block-json --file <block.cbor | -> [options]       decode a local block (binary or hex)

Network options:
  --network <name|magic>   mainnet (default), preprod, preview or a numeric magic
  --timeout <ms>           overall timeout (default 30000)
  --public-only            refuse loopback/private relay addresses
  --raw                    print the raw block CBOR as hex instead of JSON

Output options:
  --include-cbor           include raw CBOR hex of the block and each transaction
  --bigint <string|number> render big integers as strings (default) or as numbers when safe
  --compact                single-line JSON
  -h, --help               show this help
  -v, --version            show the version

A block is addressed by its point (slot + header hash). A hash alone cannot be fetched.`;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => Uint8Array;
}

/** Runs the CLI with the given arguments; returns the process exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  try {
    return await main(argv, io);
  } catch (err) {
    if (err instanceof CardanoBlockError) io.stderr(`error [${err.code}]: ${err.message}\n`);
    else io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function main(argv: string[], io: CliIo): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: argv,
      options: {
        relay: { type: "string" },
        slot: { type: "string" },
        hash: { type: "string" },
        point: { type: "string" },
        network: { type: "string" },
        timeout: { type: "string" },
        file: { type: "string" },
        "public-only": { type: "boolean" },
        raw: { type: "boolean" },
        "include-cbor": { type: "boolean" },
        bigint: { type: "string" },
        compact: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (err) {
    io.stderr(`${(err as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (args.version) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }
  if (args.bigint !== undefined && args.bigint !== "string" && args.bigint !== "number") {
    io.stderr("--bigint must be 'string' or 'number'\n");
    return 2;
  }
  const json = { bigint: (args.bigint ?? "string") as "string" | "number", indent: args.compact ? 0 : 2 };
  const decodeOpts = args["include-cbor"] ? { includeCbor: true } : {};

  if (args.file !== undefined) {
    if (args.relay !== undefined) {
      io.stderr("--file and --relay are mutually exclusive\n");
      return 2;
    }
    const data = io.readFile(args.file);
    const text = new TextDecoder("latin1").decode(data.subarray(0, Math.min(data.length, 4))).trim();
    // Hex text files start with hex digits; binary CBOR blocks start with an array header (0x82…).
    const looksHex = /^(0x)?[0-9a-fA-F]+$/.test(text);
    const input = looksHex ? new TextDecoder().decode(data).trim() : data;
    const block = decodeBlock(input, decodeOpts);
    io.stdout(`${stringifyBlock(block, json)}\n`);
    return 0;
  }

  if (args.relay === undefined) {
    io.stderr(`--relay (or --file) is required\n\n${USAGE}\n`);
    return 2;
  }
  let point: FetchBlockOptions["point"];
  if (args.point !== undefined) point = args.point;
  else if (args.hash !== undefined && args.slot === undefined) point = args.hash; // rejected with a clear message
  else point = { slot: args.slot ?? "", hash: args.hash ?? "" };

  let network: FetchBlockOptions["network"];
  if (args.network !== undefined) network = /^\d+$/.test(args.network) ? Number(args.network) : (args.network as FetchBlockOptions["network"]);
  const opts: FetchBlockOptions = {
    relay: args.relay,
    point,
    allowPrivateAddresses: !args["public-only"],
  };
  if (network !== undefined) opts.network = network;
  if (args.timeout !== undefined) opts.timeoutMs = /^\d+$/.test(args.timeout) ? Number(args.timeout) : NaN;

  const raw = await fetchRawBlock(opts);
  if (args.raw) {
    io.stdout(`${toHex(raw.cbor)}\n`);
    return 0;
  }
  io.stdout(`${stringifyBlock(decodeBlock(raw.cbor, decodeOpts), json)}\n`);
  return 0;
}

