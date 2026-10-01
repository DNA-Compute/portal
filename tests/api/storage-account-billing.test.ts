import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.hoisted(() => { process.env.SYNC_SECRET = "storage-account-test"; });
const mocks = vi.hoisted(() => ({
  customers: vi.fn(),
  retrieve: vi.fn(),
  update: vi.fn(),
  charge: vi.fn().mockResolvedValue({}),
  volumes: vi.fn(),
  pods: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  customerCache: { findMany: mocks.customers },
  podMetadata: { findMany: mocks.pods },
  walletTransaction: { create: vi.fn().mockResolvedValue({}) },
} }));
vi.mock("@/lib/stripe", () => ({ getStripe: async () => ({ customers: {
  retrieve: mocks.retrieve, update: mocks.update, createBalanceTransaction: mocks.charge,
  listBalanceTransactions: vi.fn().mockResolvedValue({ data: [] }),
} }) }));
vi.mock("@/lib/hostedai", () => ({
  getPoolSubscriptions: vi.fn().mockResolvedValue([]), getSharedVolumes: mocks.volumes,
  deleteSharedVolume: vi.fn(),
}));
vi.mock("@/lib/customer-cache", () => ({ cacheCustomer: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/pool-overview", () => ({ readPoolOverviewCache: () => null }));
vi.mock("@/lib/pricing", () => ({ getStoragePricePerGBHourCents: () => 1, getStoppedInstanceRatePercent: () => 25 }));
vi.mock("@/lib/wallet", () => ({ checkAndRefillWallet: vi.fn().mockResolvedValue({ refilled: false }), WALLET_CONFIG: {} }));
vi.mock("@/lib/email", () => ({ sendNegativeBalanceShutdownEmail: vi.fn() }));
import { POST } from "@/app/api/sync/route";

type Customer = { id: string; balance: number; email: string; metadata: Record<string, string> };
let customers: Map<string, Customer>;

function sync() {
  return POST(new NextRequest("http://localhost/api/sync", {
    method: "POST", headers: { authorization: "Bearer storage-account-test" },
  }));
}

describe("persistent shared storage account billing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    customers = new Map();
    mocks.pods.mockResolvedValue([]); // No remaining instances or PodMetadata.
    mocks.customers.mockImplementation(async () => [...customers.keys()].map(id => ({ id })));
    mocks.retrieve.mockImplementation(async (id: string) => {
      const customer = customers.get(id);
      if (!customer) throw new Error("Unknown customer");
      return customer;
    });
    mocks.update.mockImplementation(async (id: string, update: { metadata: Record<string, string> }) => {
      const customer = customers.get(id)!;
      customer.metadata = { ...customer.metadata, ...update.metadata };
      return customer;
    });
    mocks.volumes.mockResolvedValue([{ id: 7, team_id: "team", size_in_gb: 10 }]);
  });
  afterEach(() => vi.useRealTimers());

  it("keeps metering persistent volumes after the last instance metadata is gone", async () => {
    customers.set("owner", { id: "owner", email: "owner@example.com", balance: 0,
      metadata: { hostedai_team_id: "team", billing_type: "hourly" } });
    expect((await sync()).status).toBe(200);
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect((await sync()).status).toBe(200);
    expect(mocks.charge).toHaveBeenCalledTimes(2);
    expect(mocks.charge).toHaveBeenNthCalledWith(1, "owner", expect.objectContaining({ amount: 5, metadata: expect.objectContaining({ billing_type: "storage" }) }));
    expect(mocks.charge).toHaveBeenNthCalledWith(2, "owner", expect.objectContaining({ amount: 5 }));
  });

  it("charges a linked monthly alias and primary once to the canonical wallet", async () => {
    // Alias-first discovery must not select a second payer or accumulator.
    customers.set("monthly", { id: "monthly", email: "owner@example.com", balance: 0,
      metadata: { hostedai_team_id: "team", billing_type: "monthly", primary_stripe_customer_id: "primary" } });
    customers.set("primary", { id: "primary", email: "owner@example.com", balance: 0,
      metadata: { hostedai_team_id: "team", billing_type: "hourly" } });
    expect((await sync()).status).toBe(200);
    expect(mocks.charge).toHaveBeenCalledTimes(1);
    expect(mocks.charge).toHaveBeenCalledWith("primary", expect.objectContaining({ amount: 5 }));
    expect(customers.get("monthly")!.metadata.storage_window_started_at).toBeUndefined();
  });

  it("includes standalone monthly accounts without hourly pods", async () => {
    customers.set("monthly", { id: "monthly", email: "monthly@example.com", balance: 0,
      metadata: { hostedai_team_id: "team", billing_type: "monthly" } });
    expect((await sync()).status).toBe(200);
    expect(mocks.charge).toHaveBeenCalledTimes(1);
    expect(mocks.charge).toHaveBeenCalledWith("monthly", expect.objectContaining({ amount: 5 }));
  });

  it("aggregates different teams linked to one wallet without dropping a team's volume", async () => {
    customers.set("monthly", { id: "monthly", email: "owner@example.com", balance: 0,
      metadata: { hostedai_team_id: "second-team", billing_type: "monthly", primary_stripe_customer_id: "primary" } });
    customers.set("primary", { id: "primary", email: "owner@example.com", balance: 0,
      metadata: { hostedai_team_id: "team", billing_type: "hourly" } });
    mocks.volumes.mockImplementation(async (teamId: string) => [{ id: teamId === "team" ? 7 : 8, team_id: teamId, size_in_gb: 10 }]);
    expect((await sync()).status).toBe(200);
    expect(mocks.charge).toHaveBeenCalledTimes(1);
    expect(mocks.charge).toHaveBeenCalledWith("primary", expect.objectContaining({ amount: 10 }));
  });
});
