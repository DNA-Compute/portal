import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.hoisted(() => { process.env.SYNC_SECRET = "settlement-test"; });
const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  subscriptions: vi.fn(),
  charge: vi.fn().mockResolvedValue({}),
  deleteInstance: vi.fn().mockResolvedValue(undefined),
  unsubscribe: vi.fn().mockResolvedValue(undefined),
  deleteMetadata: vi.fn().mockResolvedValue({}),
  findMany: vi.fn().mockResolvedValue([]),
  updateMetadata: vi.fn().mockResolvedValue({}),
  logTerminated: vi.fn().mockResolvedValue(undefined),
  productName: vi.fn().mockResolvedValue("GPU Instance"),
}));
vi.mock("@/lib/customer-auth", () => ({
  verifyCustomerToken: () => ({ customerId: "cus_owner", email: "owner@example.com" }),
  generateCustomerToken: () => "token",
}));
vi.mock("@/lib/auth/account-resolver", () => ({ resolveOperatingContext: async () => ({
  accountId: "cus_owner",
  customer: { id: "cus_owner", email: "owner@example.com", metadata: { hostedai_team_id: "team" } },
}) }));
vi.mock("@/lib/auth/gate", () => ({ gatePermission: async () => null }));
vi.mock("@/lib/stripe", () => ({ getStripe: async () => ({ customers: {
  createBalanceTransaction: mocks.charge,
  listBalanceTransactions: vi.fn().mockResolvedValue({ data: [] }),
  retrieve: async () => ({
    id: "cus_owner", balance: 0, email: "owner@example.com",
    metadata: { hostedai_team_id: "team", billing_type: "hourly", last_storage_sync_timestamp: String(Math.floor(Date.now() / 1000)) },
  }),
} }) }));
vi.mock("@/lib/prisma", () => ({ prisma: { podMetadata: {
  findFirst: mocks.metadata,
  findUnique: mocks.metadata,
  delete: mocks.deleteMetadata,
  findMany: mocks.findMany,
  update: mocks.updateMetadata,
}, walletTransaction: { create: vi.fn().mockResolvedValue({}) }, customerCache: { findMany: vi.fn().mockResolvedValue([]) } } }));
vi.mock("@/lib/hostedai", () => ({
  getPoolSubscriptions: mocks.subscriptions,
  deleteInstance: mocks.deleteInstance,
  unsubscribeFromPool: mocks.unsubscribe,
  getUnifiedInstanceDetail: vi.fn(),
  getSharedVolumes: vi.fn().mockResolvedValue([]),
  deleteSharedVolume: vi.fn(),
}));
vi.mock("@/lib/activity", () => ({ logGPUTerminated: mocks.logTerminated, instanceProductName: mocks.productName }));
vi.mock("@/lib/email", () => ({
  sendGpuTerminatedEmail: vi.fn().mockResolvedValue(undefined),
  sendNegativeBalanceShutdownEmail: vi.fn(),
}));
vi.mock("@/lib/customer-cache", () => ({ cacheCustomer: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/pricing", () => ({ getStoppedInstanceRatePercent: () => 90, getStoragePricePerGBHourCents: () => 0 }));
vi.mock("@/lib/pool-overview", () => ({ readPoolOverviewCache: () => null }));
vi.mock("@/lib/wallet", () => ({ checkAndRefillWallet: vi.fn().mockResolvedValue({ refilled: false }), WALLET_CONFIG: {} }));

import { DELETE } from "@/app/api/instances/pool-subscription/[id]/route";
import { POST as sync } from "@/app/api/sync/route";

const instanceId = "i-11111111-1111-1111-1111-111111111111";
const now = new Date("2030-01-01T00:15:00Z");

function savedRate(basis: string | null, prepaidUntil = new Date("2030-01-01T00:30:00Z")) {
  return {
    id: "metadata", subscriptionId: instanceId, instanceId,
    displayName: "GPU", hourlyRateCents: 1200, hourlyRateBasis: basis,
    billingType: "hourly", prepaidUntil,
    stripeCustomerId: "cus_owner", poolId: "1",
    prepaidAmountCents: basis === "per_instance" ? 600 : null,
    rateSnapshot: basis === "per_instance" ? {
      version: 1, basis: "per_instance", instanceHourlyCents: 1200,
      stoppedInstanceHourlyCents: 300, stoppedRatePercent: 25,
      sharedStorageHourlyCents: 100, totalHourlyCents: 1300,
    } : null,
  };
}

async function terminate(id: string) {
  return DELETE(new NextRequest(`http://localhost/api/instances/pool-subscription/${id}`, {
    method: "DELETE", headers: { authorization: "Bearer test" },
  }), { params: Promise.resolve({ id }) });
}

describe("termination settlement uses the purchased rate basis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.subscriptions.mockResolvedValue([
      { id: instanceId, pool_id: 1, pool_name: "GPU", per_pod_info: { vgpu_count: 2 }, pods: [{ pod_status: "running" }] },
      { id: "12", pool_id: 1, pool_name: "GPU", per_pod_info: { vgpu_count: 2 }, pods: [{ pod_status: "running" }] },
    ]);
  });
  afterEach(() => vi.useRealTimers());

  it.each([instanceId, "12"])("credits unused time once for a configured two-GPU instance (%s)", async id => {
    mocks.metadata.mockResolvedValue(savedRate("per_instance"));
    expect((await terminate(id)).status).toBe(200);
    expect(mocks.charge).toHaveBeenCalledWith("cus_owner", expect.objectContaining({ amount: -300 }));
  });

  it("names the launched offering, not a placeholder, in the termination activity", async () => {
    mocks.metadata.mockResolvedValue({ ...savedRate("per_instance"), productId: "product_h100" });
    mocks.productName.mockResolvedValueOnce("H100 fractional");
    expect((await terminate(instanceId)).status).toBe(200);
    expect(mocks.productName).toHaveBeenCalledWith("product_h100");
    expect(mocks.logTerminated).toHaveBeenCalledWith("cus_owner", "H100 fractional", "GPU", instanceId);
  });

  it.each(["per_gpu", null])("preserves legacy GPU quantity when refunding (%s)", async basis => {
    mocks.metadata.mockResolvedValue(savedRate(basis));
    expect((await terminate("12")).status).toBe(200);
    expect(mocks.charge).toHaveBeenCalledWith("cus_owner", expect.objectContaining({ amount: -600 }));
  });

  it("charges overdue configured usage without multiplying GPUs or shared storage", async () => {
    mocks.metadata.mockResolvedValue(savedRate("per_instance", new Date("2030-01-01T00:00:00Z")));
    expect((await terminate(instanceId)).status).toBe(200);
    expect(mocks.charge).toHaveBeenCalledWith("cus_owner", expect.objectContaining({ amount: 300 }));
  });

  it.each([instanceId, "12"])("refunds the running-rate prepayment even after the instance stops (%s)", async id => {
    mocks.metadata.mockResolvedValue({ ...savedRate("per_instance"), prepaidAmountCents: 600 });
    mocks.subscriptions.mockResolvedValue([{ id, per_pod_info: { vgpu_count: 2 }, pods: [{ pod_status: "stopped" }] }]);
    expect((await terminate(id)).status).toBe(200);
    expect(mocks.charge).toHaveBeenCalledWith("cus_owner", expect.objectContaining({ amount: -300 }));
  });

  it("charges stopped time after the prepaid interval at the captured reservation price", async () => {
    mocks.metadata.mockResolvedValue(savedRate("per_instance", new Date("2030-01-01T00:00:00Z")));
    mocks.subscriptions.mockResolvedValue([{ id: instanceId, per_pod_info: { vgpu_count: 2 }, pods: [{ pod_status: "stopped" }] }]);
    expect((await terminate(instanceId)).status).toBe(200);
    expect(mocks.charge).toHaveBeenCalledWith("cus_owner", expect.objectContaining({ amount: 75 }));
  });

  it("refunds the remaining fraction of the actual saved payment rather than recomputing the charge", async () => {
    mocks.metadata.mockResolvedValue({ ...savedRate("per_instance"), prepaidAmountCents: 300 });
    expect((await terminate(instanceId)).status).toBe(200);
    expect(mocks.charge).toHaveBeenCalledWith("cus_owner", expect.objectContaining({ amount: -150 }));
  });

  it("does not settle monthly allocations", async () => {
    mocks.metadata.mockResolvedValue({ ...savedRate("per_instance"), billingType: "monthly" });
    expect((await terminate(instanceId)).status).toBe(200);
    expect(mocks.charge).not.toHaveBeenCalled();
  });

  it("preserves malformed configured settlement data instead of silently deleting it", async () => {
    mocks.metadata.mockResolvedValue({ ...savedRate("per_instance"), rateSnapshot: null });
    expect((await terminate(instanceId)).status).toBe(409);
    expect(mocks.charge).not.toHaveBeenCalled();
    expect(mocks.deleteMetadata).not.toHaveBeenCalled();
    expect(mocks.deleteInstance).not.toHaveBeenCalled();
  });

  it.each([instanceId, "12"])("refunds the saved payment when provider status is unavailable (%s)", async id => {
    mocks.metadata.mockResolvedValue(savedRate("per_instance"));
    mocks.subscriptions.mockRejectedValue(new Error("Provider unavailable"));
    expect((await terminate(id)).status).toBe(200);
    expect(mocks.charge).toHaveBeenCalledWith("cus_owner", expect.objectContaining({ amount: -300 }));
  });

  it.each([0, 300])("refunds only the unused captured stopped prepayment after renewal (%sc/hr)", async stoppedHourlyCents => {
    const metadata = savedRate("per_instance", new Date("2030-01-01T00:00:00Z"));
    metadata.rateSnapshot!.stoppedInstanceHourlyCents = stoppedHourlyCents;
    mocks.metadata.mockResolvedValue(metadata);
    mocks.findMany.mockResolvedValue([metadata]);
    mocks.updateMetadata.mockImplementation(async ({ data }) => {
      Object.assign(metadata, data);
      return metadata;
    });
    mocks.subscriptions.mockResolvedValue([{
      id: instanceId, status: "active", per_pod_info: { vgpu_count: 2 },
      pods: [{ pod_status: "stopped" }],
    }]);
    const result = await sync(new NextRequest("http://localhost/api/sync", {
      method: "POST", headers: { authorization: "Bearer settlement-test" },
    }));
    expect(result.status).toBe(200);
    expect((await terminate(instanceId)).status).toBe(200);
    if (stoppedHourlyCents === 0) {
      expect(mocks.charge).not.toHaveBeenCalled();
    } else {
      expect(mocks.charge).toHaveBeenCalledTimes(2);
      expect(mocks.charge).toHaveBeenNthCalledWith(1, "cus_owner", expect.objectContaining({ amount: 150 }));
      expect(mocks.charge).toHaveBeenNthCalledWith(2, "cus_owner", expect.objectContaining({ amount: -75 }));
    }
  });
});
