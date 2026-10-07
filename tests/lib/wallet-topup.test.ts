import { describe, expect, it } from "vitest";
import { isValidTopUpAmount } from "@/lib/wallet-topup";

describe("wallet top-up amounts", () => {
  it("accepts every preset and whole-dollar custom amounts inside the bounds", () => {
    for (const cents of [2500, 5000, 10000, 25000, 50000, 3700, 1_000_000]) expect(isValidTopUpAmount(cents)).toBe(true);
  });
  it("rejects amounts outside the bounds, cents, fractions and non-numbers", () => {
    for (const value of [2400, 1_000_100, 3750, 2500.5, 0, -2500, NaN, "5000", null]) expect(isValidTopUpAmount(value)).toBe(false);
  });
});
