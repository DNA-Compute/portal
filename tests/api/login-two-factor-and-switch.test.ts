import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Before the 2FA code, verify must not hand out the console link, the Stripe link or billing data.
// Switching account must keep an admin's Login as marked as Login as, and keep 2FA satisfied.

const m = vi.hoisted(() => ({
  twoFactor: null as null | { verified: boolean; createdAt: Date },
  createOneTimeLogin: vi.fn(),
  billingPortal: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    twoFactorAuth: { findUnique: vi.fn(async () => m.twoFactor) },
    user: { findUnique: vi.fn(async () => ({ id: "user_1", email: "owner@example.com" })) },
    teamMembership: {
      findUnique: vi.fn(async () => ({ role: "teamAdmin", isOwner: true, status: "active", revokedAt: null })),
    },
  },
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: async () => ({ billingPortal: { sessions: { create: m.billingPortal } } }),
}));
vi.mock("@/lib/auth/account-resolver", () => ({
  resolveOperatingContext: async () => ({
    customer: { id: "cus_1", email: "owner@example.com", metadata: { hostedai_team_id: "team-1" } },
    accountId: "cus_1",
    allTeamIds: ["team-1"],
    allCustomerIds: ["cus_1"],
    monthlyCustomerIds: [],
  }),
}));
vi.mock("@/lib/customer-suspension", () => ({ findSuspension: async () => null }));
vi.mock("@/lib/hostedai", () => ({ createOneTimeLogin: m.createOneTimeLogin, ensureRoles: vi.fn(async () => ({})) }));

import {
  generateCustomerToken,
  generateAdminBypassToken,
  decodeCustomerToken,
  verifyCustomerToken,
} from "@/lib/auth/customer";
import { POST as verify } from "@/app/api/account/verify/route";
import { POST as switchAccount } from "@/app/api/session/switch-account/route";

const EMAIL = "owner@example.com";

function post(url: string, body: object, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CUSTOMER_JWT_SECRET = "test-secret";
  m.twoFactor = { verified: true, createdAt: new Date(Date.now() - 60_000) };
});

describe("POST /api/account/verify while the 2FA code is needed", () => {
  it("returns only the code prompt: no console link, Stripe link, billing data or session", async () => {
    const response = await verify(post("/api/account/verify", { token: generateCustomerToken(EMAIL, "cus_1") }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ twoFactor: { enabled: true, hasBackupCodes: false }, twoFactorPending: true, userEmail: EMAIL });
    expect(m.createOneTimeLogin).not.toHaveBeenCalled();
    expect(m.billingPortal).not.toHaveBeenCalled();
    expect(response.cookies.get("packet_session")).toBeUndefined();
  });
});

describe("POST /api/session/switch-account", () => {
  it("keeps an admin's Login as marked as Login as, and leaves the browser's session cookie alone", async () => {
    const loginAs = generateAdminBypassToken(EMAIL, "cus_1", "admin@example.com");
    const response = await switchAccount(post("/api/session/switch-account", { accountId: "cus_2" }, {
      Authorization: `Bearer ${loginAs}`,
      Cookie: "packet_session=someone-elses-session",
    }));
    const body = await response.json();
    const switched = decodeCustomerToken(body.token)!;

    expect(response.status).toBe(200);
    expect(switched.skipTwoFactor).toBe(true);
    expect(switched.impersonator).toEqual({ adminEmail: "admin@example.com" });
    expect(switched.activeAccountId).toBe("cus_2");
    expect(response.cookies.get("packet_session")).toBeUndefined();
  });

  it("keeps 2FA satisfied, so a 2FA user can use the switched token", async () => {
    const signedIn = generateCustomerToken(EMAIL, "cus_1", { twoFactorVerified: true });
    const response = await switchAccount(post("/api/session/switch-account", { accountId: "cus_2" }, {
      Authorization: `Bearer ${signedIn}`,
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(await verifyCustomerToken(body.token)).not.toBeNull();
    expect(decodeCustomerToken(body.token)!.impersonator).toBeUndefined();
  });

  it("refuses a login link whose 2FA code was never entered", async () => {
    const response = await switchAccount(post("/api/session/switch-account", { accountId: "cus_2" }, {
      Authorization: `Bearer ${generateCustomerToken(EMAIL, "cus_1")}`,
    }));
    expect(response.status).toBe(401);
  });
});
