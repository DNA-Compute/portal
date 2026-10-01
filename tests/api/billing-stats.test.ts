import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import type { AuthenticatedCustomer } from "@/lib/auth/helpers";
import { can } from "@/lib/auth/role-permissions";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  ledger: vi.fn(),
  summary: vi.fn(),
  audit: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/lib/auth/helpers", () => ({ getAuthenticatedCustomer: mocks.auth }));
vi.mock("@/lib/prisma", () => ({ prisma: { teamAuditLog: { create: mocks.audit } } }));
vi.mock("@/lib/stripe", () => ({ getStripe: async () => ({ customers: { listBalanceTransactions: mocks.ledger } }) }));
vi.mock("@/lib/hostedai", () => ({
  getTeamBillingSummaryV2: mocks.summary,
  formatBillingDatetime: (date: Date) => date.toISOString(),
}));
vi.mock("@/lib/pricing", () => ({ getStoppedInstanceRatePercent: () => 25 }));
vi.mock("@/lib/lifecycle", () => ({ addSpend: vi.fn() }));
vi.mock("@/lib/customer-cache", () => ({ cacheCustomer: vi.fn() }));
vi.mock("@/lib/invoice", () => ({ createInvoiceForPayment: vi.fn() }));

import { GET } from "@/app/api/account/billing-stats/route";
import { GET as history } from "@/app/api/billing/history/route";
import { getWalletTransactions } from "@/lib/wallet";

type Transaction = Pick<Stripe.CustomerBalanceTransaction, "id" | "amount" | "created" | "currency" | "description" | "metadata">;
const NOW = new Date("2030-06-15T12:00:00.000Z");
const MONTH_START = Date.parse("2030-06-01T00:00:00Z") / 1000;
let ledger: Map<string, Transaction[]>;
let auth: AuthenticatedCustomer;
let failAfter: number;

function transaction(id: string, amount: number, fields: Partial<Transaction> = {}): Transaction {
  return { id, amount, created: NOW.getTime() / 1000 - 60, currency: "usd", description: "GPU usage", metadata: {}, ...fields };
}

function request() {
  return new NextRequest("http://localhost/api/account/billing-stats", {
    headers: { authorization: "Bearer finance-token" },
  });
}

// Stripe's list is both a first-page promise and an auto-paginating async iterable.
// Model date filtering and page boundaries at that external seam, not in the route.
function listTransactions(customerId: string, params: Stripe.CustomerListBalanceTransactionsParams = {}) {
  const range = typeof params.created === "object" ? params.created : undefined;
  const rows = (ledger.get(customerId) ?? [])
    .filter(row => range?.gte === undefined || row.created >= range.gte)
    .sort((a, b) => b.created - a.created);
  const pageSize = params.limit ?? 10;
  return Object.assign(Promise.resolve({ data: rows.slice(0, pageSize) }), {
    async *[Symbol.asyncIterator]() {
      for (let offset = 0; offset < rows.length; offset += pageSize) {
        if (offset >= failAfter) throw new Error("Stripe ledger page unavailable");
        for (const row of rows.slice(offset, offset + pageSize)) yield row;
      }
    },
  });
}

describe("monthly retail wallet billing statistics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    failAfter = Infinity;
    ledger = new Map([["cus_owner", []]]);
    auth = {
      payload: { customerId: "cus_owner", email: "finance@example.com" },
      customer: { id: "cus_owner" },
      accountId: "cus_owner",
      teamId: "team_1",
      allTeamIds: ["team_1"],
      membership: { userId: "user_finance", role: "financeManager", isOwner: false },
      can: permission => can("financeManager", false, permission),
    } as AuthenticatedCustomer;
    mocks.auth.mockImplementation(async () => auth);
    mocks.ledger.mockImplementation(listTransactions);
    mocks.summary.mockResolvedValue({
      total_cost: 9999,
      gpuaas_summary: [{ pool_hours: 7 }],
      instance_billing_summary: [{ hours: 3 }],
      shared_storage_billing_summary: [{ storage_name: "native-volume", cost: 800, hours: 4 }],
    });
  });
  afterEach(() => vi.useRealTimers());

  it("reports retail wallet debits and storage metadata independently of native prices", async () => {
    ledger.set("cus_owner", [
      transaction("gpu", 650),
      transaction("storage", 125, { metadata: { billing_type: "storage" } }),
    ]);
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ totalCost: 7.75, storageCost: 1.25, gpuHours: 10, storageHours: 4 });
    expect(body).not.toHaveProperty("instances");
    expect(body).not.toHaveProperty("storageVolumes");
  });

  it("uses inclusive UTC month start and excludes prior-month and future records", async () => {
    vi.setSystemTime(new Date("2030-06-01T00:00:30Z"));
    ledger.set("cus_owner", [
      transaction("prior", 10000, { created: MONTH_START - 1 }),
      transaction("boundary", 175, { created: MONTH_START }),
      transaction("now", 25, { created: MONTH_START + 30 }),
      transaction("future", 20000, { created: MONTH_START + 31 }),
    ]);
    const response = await GET(request());
    const body = await response.json();
    expect(body).toMatchObject({
      totalCost: 2,
      periodStart: "2030-06-01T00:00:00.000Z",
      periodEnd: "2030-06-01T00:00:30.000Z",
    });
    expect(body.dailyCharges).toEqual(expect.arrayContaining([
      { date: "2030-05-31", amountCents: 10000 },
      { date: "2030-06-01", amountCents: 200 },
    ]));
  });

  it("includes charges beyond the 100-record preview without fetching years of history", async () => {
    ledger.set("cus_owner", [
      ...Array.from({ length: 101 }, (_, i) => transaction(`month_${i}`, 100, { created: MONTH_START + i })),
      ...Array.from({ length: 300 }, (_, i) => transaction(`old_${i}`, 900, { created: MONTH_START - i - 1 })),
    ]);
    failAfter = 200; // Reading historical pages unnecessarily makes the ledger unavailable.
    expect((await getWalletTransactions("cus_owner", 100)).reduce((sum, row) => sum + row.amount, 0)).toBe(10000);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalCost: 101 });
  });

  it("shares history bookkeeping exclusions, keeps gross debits, and classifies only storage metadata", async () => {
    ledger.set("cus_owner", [
      transaction("gpu", 400, { description: "Storage-like description is not classification" }),
      transaction("storage", 150, { metadata: { billing_type: "storage" } }),
      transaction("funding", -10000, { metadata: { type: "wallet_funding" } }),
      transaction("voucher", -500, { metadata: { type: "voucher" } }),
      transaction("refund", -250, { metadata: { billing_type: "storage", type: "deployment_refund" } }),
      transaction("hold", 10000, { metadata: { type: "invoice_balance_hold" } }),
      transaction("restore", -10000, { metadata: { type: "invoice_balance_restore" } }),
      transaction("legacy_hold", 9000, { description: "Temporary HOLD for invoice generation" }),
      transaction("legacy_restore", 9000, { description: "Restore after INVOICE generation" }),
    ]);
    const body = await (await GET(request())).json();
    const historyBody = await (await history(request())).json();
    expect(body).toMatchObject({ totalCost: 5.5, storageCost: 1.5 });
    expect(historyBody.allTimeStats).toMatchObject({ totalSpent: 5.5, totalCredits: 107.5, transactionCount: 5 });
  });

  it("retains recorded retail charges when no Hosted.ai team exists", async () => {
    auth.teamId = undefined;
    ledger.set("cus_owner", [transaction("existing_charge", 725)]);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalCost: 7.25, storageCost: 0, periodStart: "2030-06-01T00:00:00.000Z" });
  });

  it("keeps retail money available when the optional provider usage summary fails", async () => {
    ledger.set("cus_owner", [transaction("retail", 300)]);
    mocks.summary.mockRejectedValue(new Error("Native usage unavailable"));
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalCost: 3, storageCost: 0 });
  });

  it("fails explicitly rather than returning zero when the ledger is unavailable", async () => {
    auth.teamId = undefined;
    mocks.ledger.mockImplementation(() => { throw new Error("Stripe unavailable"); });
    const response = await GET(request());
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toEqual(expect.any(String));
    expect(body).not.toHaveProperty("totalCost");
  });

  it("never returns a partial total when a later Stripe page fails", async () => {
    ledger.set("cus_owner", Array.from({ length: 101 }, (_, i) => transaction(`charge_${i}`, 100)));
    failAfter = 100;
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("totalCost");
  });

  it("rejects mixed-currency customer charges instead of reporting a USD sum", async () => {
    ledger.set("cus_owner", [transaction("usd", 100), transaction("eur", 200, { currency: "eur" })]);
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("totalCost");
  });

  it("uses the resolved active owner's wallet, not the member's JWT customer or a monthly alias", async () => {
    auth.payload.customerId = "cus_member";
    ledger.set("cus_member", [transaction("member", 80000)]);
    ledger.set("cus_monthly", [transaction("subscription", 90000)]);
    ledger.set("cus_owner", [transaction("owner", 650)]);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ totalCost: 6.5 });
  });

  it.each(["member", "readOnlyMember"] as const)("denies %s access even when the wallet has charges", async role => {
    auth.membership.role = role;
    auth.can = permission => can(role, false, permission);
    ledger.set("cus_owner", [transaction("private", 650)]);
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty("totalCost");
    expect(mocks.ledger).not.toHaveBeenCalled();
  });

  it("preserves authentication failures without revealing wallet data", async () => {
    mocks.auth.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty("totalCost");
    expect(mocks.ledger).not.toHaveBeenCalled();
  });
});
