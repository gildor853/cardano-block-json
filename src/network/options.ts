// Validation of caller-supplied network options: relay address, block point, network magic.
import { isIP } from "node:net";
import { fromHex } from "../bytes.js";
import { CardanoBlockError } from "../errors.js";

export interface RelayAddress {
  host: string;
  port: number;
}

/** A chain point: BlockFetch needs both the slot and the header hash of the block. */
export interface Point {
  slot: number | bigint | string;
  hash: string;
}

export interface NormalizedPoint {
  slot: bigint;
  hash: string;
}

export type NetworkName = "mainnet" | "preprod" | "preview";

/** Network magic numbers of the public Cardano networks. */
export const NETWORK_MAGIC: Readonly<Record<NetworkName, number>> = Object.freeze({
  mainnet: 764824073,
  preprod: 1,
  preview: 2,
});

const invalid = (message: string, details?: Record<string, unknown>): never => {
  throw new CardanoBlockError("INVALID_ARGUMENT", message, details);
};

const HOSTNAME_LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;

function validHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const h = host.endsWith(".") ? host.slice(0, -1) : host;
  return h.split(".").every((l) => HOSTNAME_LABEL.test(l));
}

function validatePort(port: unknown): number {
  const n = typeof port === "string" && /^\d{1,5}$/.test(port) ? Number(port) : port;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 65535) {
    invalid(`relay port must be an integer between 1 and 65535, got ${JSON.stringify(port)}`);
  }
  return n as number;
}

function validateHost(host: unknown): string {
  if (typeof host !== "string") return invalid("relay host must be a string");
  const h = host.trim();
  if (isIP(h) !== 0 || validHostname(h)) return h;
  return invalid(`relay host ${JSON.stringify(host)} is not a valid hostname or IP address`);
}

/**
 * Parses `"host:port"`, `"[ipv6]:port"` or `{ host, port }`. The port is required: Cardano relays
 * do not share a single well-known port (3001 is only a convention).
 */
export function parseRelay(relay: string | RelayAddress): RelayAddress {
  if (typeof relay === "object" && relay !== null) {
    return { host: validateHost(relay.host), port: validatePort(relay.port) };
  }
  if (typeof relay !== "string") return invalid("relay must be a \"host:port\" string or { host, port }");
  const s = relay.trim();
  if (s.length === 0 || s.length > 300) return invalid("relay must be a non-empty \"host:port\" string");
  if (/[\s/@?#]/.test(s) || s.includes("://")) {
    return invalid(`relay must be a plain "host:port" (no scheme, path or credentials), got ${JSON.stringify(relay)}`);
  }
  const bracket = /^\[([^\]]+)\]:(\d+)$/.exec(s);
  if (bracket) {
    if (isIP(bracket[1]!) !== 6) return invalid(`invalid IPv6 address in relay ${JSON.stringify(relay)}`);
    return { host: bracket[1]!, port: validatePort(bracket[2]) };
  }
  const idx = s.lastIndexOf(":");
  if (idx <= 0 || s.indexOf(":") !== idx) {
    return invalid(`relay must be "host:port" (IPv6 as "[addr]:port"), got ${JSON.stringify(relay)}`);
  }
  return { host: validateHost(s.slice(0, idx)), port: validatePort(s.slice(idx + 1)) };
}

/**
 * Validates a point. Accepts `{ slot, hash }` or the string forms `"<slot>.<hash>"` / `"<slot>:<hash>"`.
 * A hash alone is rejected: BlockFetch addresses blocks by (slot, hash).
 */
export function parsePoint(point: Point | string): NormalizedPoint {
  let slotIn: unknown;
  let hashIn: unknown;
  if (typeof point === "string") {
    const m = /^\s*(\d+)\s*[.:]\s*([0-9a-fA-F]+)\s*$/.exec(point);
    if (!m) {
      if (/^\s*[0-9a-fA-F]{64}\s*$/.test(point)) {
        invalid(
          "a block hash alone is not enough: BlockFetch needs a point (slot + hash). Provide the block's slot " +
            "as well (explorers, db-sync, Koios and Blockfrost show it next to the hash).",
        );
      }
      invalid(`point string must be "<slot>.<hash>", got ${JSON.stringify(point)}`);
    }
    slotIn = m![1];
    hashIn = m![2];
  } else if (typeof point === "object" && point !== null) {
    slotIn = point.slot;
    hashIn = point.hash;
  } else {
    invalid("point must be { slot, hash }");
  }
  if (slotIn === undefined || slotIn === null || slotIn === "") {
    invalid(
      "point.slot is required: BlockFetch needs a point (slot + hash), a block hash alone cannot be fetched. " +
        "Provide the block's slot as well (explorers, db-sync, Koios and Blockfrost show it next to the hash).",
    );
  }
  let slot: bigint;
  if (typeof slotIn === "bigint") slot = slotIn;
  else if (typeof slotIn === "number" && Number.isSafeInteger(slotIn)) slot = BigInt(slotIn);
  else if (typeof slotIn === "string" && /^\d{1,20}$/.test(slotIn.trim())) slot = BigInt(slotIn.trim());
  else return invalid(`point.slot must be a non-negative integer, got ${JSON.stringify(String(slotIn))}`);
  if (slot < 0n || slot > 0xffffffffffffffffn) invalid("point.slot must be a 64-bit unsigned integer");
  if (typeof hashIn !== "string") return invalid("point.hash must be a hex string");
  const hash = hashIn.trim().toLowerCase().replace(/^0x/, "");
  if (hash.length !== 64 || !fromHex(hash)) invalid(`point.hash must be 32 bytes of hex (64 characters), got ${JSON.stringify(hashIn)}`);
  return { slot, hash };
}

/** Resolves a network name or magic number to the 32-bit network magic. */
export function networkMagic(network: NetworkName | number | undefined): number {
  if (network === undefined) return NETWORK_MAGIC.mainnet;
  if (typeof network === "string") {
    const m = (NETWORK_MAGIC as Record<string, number>)[network];
    if (m === undefined) invalid(`unknown network ${JSON.stringify(network)}; use "mainnet", "preprod", "preview" or a magic number`);
    return m!;
  }
  if (!Number.isInteger(network) || network < 0 || network > 0xffffffff) {
    invalid("network magic must be an integer between 0 and 4294967295");
  }
  return network;
}

// ----------------------------------------------------------------------------------------------
// Address classification (SSRF guard)

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, x) => n * 256 + Number(x), 0);
}

const V4_BLOCKS: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function v4Private(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0);
  });
}

function expandV6(ip: string): number[] | undefined {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4ToInt(v4[1]!);
    tail = [n >>> 16, n & 0xffff];
    s = s.slice(0, -v4[1]!.length) + "0:0";
  }
  const [head, rest] = s.split("::") as [string, string | undefined];
  const hs = head ? head.split(":") : [];
  const rs = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const fill = 8 - hs.length - rs.length;
  if (rest === undefined && hs.length !== 8) return undefined;
  const groups = [...hs, ...Array<string>(rest === undefined ? 0 : fill).fill("0"), ...rs].map((g) => parseInt(g || "0", 16));
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups.length === 8 ? groups : undefined;
}

function v6Private(ip: string): boolean {
  const g = expandV6(ip);
  if (!g) return true;
  const allZeroUntil = (n: number): boolean => g.slice(0, n).every((x) => x === 0);
  if (allZeroUntil(8)) return true; // ::
  if (allZeroUntil(7) && g[7] === 1) return true; // ::1
  if (allZeroUntil(5) && g[5] === 0xffff) return v4Private(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`); // v4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b) return v4Private(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`); // NAT64
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link local
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

/** `true` for loopback, private, link-local, CGNAT, multicast, reserved and documentation addresses. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Private(ip);
  if (kind === 6) return v6Private(ip);
  return true;
}
