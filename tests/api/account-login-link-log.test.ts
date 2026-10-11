import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  sendLoginEmailForCustomer: vi.fn(),
  logLoginLinkSent: vi.fn(),
  logLoginLinkNoAccount: vi.fn(),
}));

vi.mock("@/lib/stripe", () => ({ getStripe: async () => ({ customers: { list: async () => ({ data: [] }) } }) }));
vi.mock("@/lib/settings", () => ({ isServiceConfigured: async () => true }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: () => ({ success: true }), getClientIp: () => "127.0.0.1" }));
vi.mock("@/lib/admin-activity", () => ({
  logLoginLinkSent: mocks.logLoginLinkSent,
  logLoginLinkNoAccount: mocks.logLoginLinkNoAccount,
}));
vi.mock("@/lib/hostedai", () => ({ createTeam: vi.fn(), getDefaultPolicies: vi.fn(), getRoles: vi.fn() }));
vi.mock("@/lib/branding", () => ({ getBrandName: () => "Test" }));
vi.mock("@/lib/customer-login-email", () => ({ sendLoginEmailForCustomer: mocks.sendLoginEmailForCustomer }));

import { POST } from "@/app/api/account/route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  mocks.logLoginLinkNoAccount.mockResolvedValue(undefined);
});

describe("POST /api/account login link activity", () => {
  it("records a request for an email with no account as no account, not as a sent link", async () => {
    mocks.sendLoginEmailForCustomer.mockResolvedValue(false);
    const res = await POST(new NextRequest("http://localhost/api/account", {
      method: "POST",
      body: JSON.stringify({ email: "Nobody@Example.com" }),
    }));

    expect(res.status).toBe(200);
    expect(mocks.logLoginLinkSent).not.toHaveBeenCalled();
    expect(mocks.logLoginLinkNoAccount).toHaveBeenCalledWith("nobody@example.com");
  });
});
