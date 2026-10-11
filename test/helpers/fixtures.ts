import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/${name}.cbor`, import.meta.url))));
}
