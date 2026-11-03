import { describe, it, expect, vi, beforeEach } from "vitest";

// A login link alone must not open the account when 2FA is on: every route checks the token with
// verifyCustomerToken, which refuses it until the code is entered.

const twoFactor = vi.hoisted(() => ({ row: null as null | { verified: boolean; createdAt: Date } }));
vi.mock("@/lib/prisma", () => ({
  prisma: { twoFactorAuth: { findUnique: vi.fn(async () => twoFactor.row) } },
}));

import {
  generateCustomerToken,
  generateAdminBypassToken,
  generateTwoFactorVerifiedToken,
  verifyCustomerToken,
} from "@/lib/auth/customer";

const EMAIL = "owner@example.com";
const setUpSecondsAgo = (seconds: number) => ({ verified: true, createdAt: new Date(Date.now() - seconds * 1000) });

describe("verifyCustomerToken and 2FA", () => {
  beforeEach(() => {
    process.env.CUSTOMER_JWT_SECRET = "test-secret";
    twoFactor.row = null;
  });

  it("refuses a login link issued after 2FA was set up, until the code is entered", async () => {
    twoFactor.row = setUpSecondsAgo(60);
    const link = generateCustomerToken(EMAIL, "cus_1");
    expect(await verifyCustomerToken(link)).toBeNull();

    const afterCode = generateTwoFactorVerifiedToken(link)!;
    expect((await verifyCustomerToken(afterCode))?.email).toBe(EMAIL);
  });

  it("accepts tokens when 2FA is off or its setup was never confirmed", async () => {
    const link = generateCustomerToken(EMAIL, "cus_1");
    expect(await verifyCustomerToken(link)).not.toBeNull();

    twoFactor.row = { verified: false, createdAt: new Date(Date.now() - 60_000) };
    expect(await verifyCustomerToken(link)).not.toBeNull();
  });

  it("keeps a token issued before 2FA was set up, so turning it on doesn't sign the user out", async () => {
    const earlier = generateCustomerToken(EMAIL, "cus_1");
    twoFactor.row = { verified: true, createdAt: new Date(Date.now() + 2000) };
    expect(await verifyCustomerToken(earlier)).not.toBeNull();
  });

  it("accepts admin Login as tokens and session tokens, which never wait for a code", async () => {
    twoFactor.row = setUpSecondsAgo(60);
    expect(await verifyCustomerToken(generateAdminBypassToken(EMAIL, "cus_1", "admin@example.com"))).not.toBeNull();
    expect(await verifyCustomerToken(generateCustomerToken(EMAIL, "cus_1", { twoFactorVerified: true }))).not.toBeNull();
  });

  it("still refuses a bad or expired token without asking the database", async () => {
    expect(await verifyCustomerToken("not-a-token")).toBeNull();
  });
});
