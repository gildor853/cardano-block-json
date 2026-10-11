import { describe, expect, it } from "vitest";
import { decodeAddress } from "../src/address.js";
import { fromHex } from "../src/bytes.js";

const a = (hex: string) => decodeAddress(fromHex(hex)!);
const PAY = "9493315cd92eb5d8c4304e67b7e16ae36d61d34502694657811a2c8e";
const STAKE = "337b62cfff6403a06a3acbc34f8c46003c69fe79a3628cefa9c47251";
const SCRIPT = "c37b1b5dc0669f1d3c61a6fddb2e8fde96be87b881c60bce8e8d542f";

describe("decodeAddress (CIP-19 test vectors)", () => {
  it("base addresses", () => {
    expect(a(`01${PAY}${STAKE}`)).toMatchObject({
      type: "base",
      typeId: 0,
      networkId: 1,
      bech32: "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x",
      paymentCredential: { type: "key", hash: PAY },
      stakeCredential: { type: "key", hash: STAKE },
    });
    expect(a(`11${SCRIPT}${STAKE}`).bech32).toBe(
      "addr1z8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gten0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs9yc0hh",
    );
    expect(a(`21${PAY}${SCRIPT}`).stakeCredential).toEqual({ type: "script", hash: SCRIPT });
    expect(a(`31${SCRIPT}${SCRIPT}`).paymentCredential).toEqual({ type: "script", hash: SCRIPT });
    expect(a(`00${PAY}${STAKE}`).bech32).toBe(
      "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgs68faae",
    );
  });

  it("pointer, enterprise and reward addresses", () => {
    expect(a(`41${PAY}8198bd431b03`)).toMatchObject({
      type: "pointer",
      bech32: "addr1gx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer5pnz75xxcrzqf96k",
      pointer: { slot: 2498243n, txIndex: 27n, certIndex: 3n },
    });
    expect(a(`51${SCRIPT}8198bd431b03`).paymentCredential?.type).toBe("script");
    expect(a(`61${PAY}`)).toMatchObject({ type: "enterprise", bech32: "addr1vx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzers66hrl8" });
    expect(a(`71${SCRIPT}`).bech32).toBe("addr1w8phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcyjy7wx");
    expect(a(`e1${STAKE}`)).toMatchObject({ type: "reward", bech32: "stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw" });
    expect(a(`f1${SCRIPT}`).bech32).toBe("stake178phkx6acpnf78fuvxn0mkew3l0fd058hzquvz7w36x4gtcccycj5");
    expect(a(`e0${STAKE}`).bech32).toBe("stake_test1uqehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gssrtvn");
  });

  it("Byron addresses", () => {
    const hex = "82d818582183581cba970ad36654d8dd8f74274b733452ddeab9a62a397746be3c42ccdda0001a9026da5b";
    expect(a(hex)).toMatchObject({ type: "byron", typeId: 8, base58: "Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi" });
  });

  it("never throws on malformed addresses", () => {
    expect(decodeAddress(new Uint8Array())).toMatchObject({ type: "unknown" });
    expect(a("01ab")).toMatchObject({ type: "unknown", typeId: 0 });
    expect(a("41ab")).toMatchObject({ type: "unknown" });
    expect(a("61ab")).toMatchObject({ type: "unknown" });
    expect(a("e1ab")).toMatchObject({ type: "unknown" });
    expect(a("91" + PAY)).toMatchObject({ type: "unknown", typeId: 9 });
    // Pointer with an unterminated variable-length integer: still a pointer, no pointer fields.
    const p = a(`41${PAY}ffff`);
    expect(p.type).toBe("pointer");
    expect(p.pointer).toBeUndefined();
  });
});
