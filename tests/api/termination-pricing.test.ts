import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.hoisted(() => { process.env.SYNC_SECRET = "settlement-test"; });
const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  subscriptions: vi.fn(),
  charge: vi.fn().mockResolvedValue({}),
  chargeOptions: vi.fn(),
  deleteInstance: vi.fn().mockResolvedValue(undefined),
  detail: vi.fn(),
  unsubscribe: vi.fn().mockResolvedValue(undefined),
  deleteMetadata: vi.fn().mockResolvedValue({}),
  findMany: vi.fn().mockResolvedValue([]),
  updateMetadata: vi.fn().mockResolvedValue({}),
  claim: vi.fn().mockResolvedValue({ count: 1 }),
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
  createBalanceTransaction: (id: string, params: unknown, options?: unknown) => {
    mocks.chargeOptions(options);
    return mocks.charge(id, params);
  },
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
  updateMany: async (args: unknown) => { await mocks.updateMetadata(args); return mocks.claim(args); },
}, walletTransaction: { create: vi.fn().mockResolvedValue({}) }, customerCache: { findMany: vi.fn().mockResolvedValue([]) } } }));
// Ownership has its own tests (instance-ownership-routes); these cover what happens once it passes.
vi.mock("@/lib/auth/instance-ownership", () => ({ ownsInstance: async () => true, rejectUnownedInstance: async () => null, rejectUnownedService: async () => null }));
vi.mock("@/lib/hostedai", () => ({
  getPoolSubscriptions: mocks.subscriptions,
  deleteInstance: mocks.deleteInstance,
  unsubscribeFromPool: mocks.unsubscribe,
  getUnifiedInstanceDetail: mocks.detail,
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

  it.each([instanceId, "12"])("credits back instead of charging again when a billing run paid the overdue time first (%s)", async id => {
    // The billing run charged 00:00-00:30 and moved the paid-up time to 00:30 while this
    // termination still held the old 00:00 value.
    const overdue = savedRate("per_instance", new Date("2030-01-01T00:00:00Z"));
    mocks.metadata.mockImplementation(async (args: { select?: object }) =>
      args?.select ? { prepaidUntil: new Date("2030-01-01T00:30:00Z"), prepaidAmountCents: 600 } : { ...overdue });
    mocks.claim.mockResolvedValueOnce({ count: 0 });
    expect((await terminate(id)).status).toBe(200);
    expect(mocks.charge).toHaveBeenCalledTimes(1);
    expect(mocks.charge).toHaveBeenCalledWith("cus_owner", expect.objectContaining({ amount: -300 }));
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

  it("settles each GPU under one key, so a second terminate at once can't credit the unused time again", async () => {
    mocks.metadata.mockResolvedValue(savedRate("per_instance"));
    await Promise.all([terminate(instanceId), terminate(instanceId)]);
    expect(mocks.chargeOptions).toHaveBeenCalledTimes(2);
    const key = `settle_credit_metadata_${new Date("2030-01-01T00:30:00Z").getTime()}`;
    expect(mocks.chargeOptions).toHaveBeenNthCalledWith(1, { idempotencyKey: key });
    expect(mocks.chargeOptions).toHaveBeenNthCalledWith(2, { idempotencyKey: key });
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

  it.each([instanceId, "12"])("changes nothing when hosted.ai can't list the team's GPUs (%s)", async id => {
    // The GPU can't be deleted then either, and the listing is what proves a later 403 means "gone".
    mocks.metadata.mockResolvedValue(savedRate("per_instance"));
    mocks.subscriptions.mockRejectedValue(new Error("Provider unavailable"));
    expect((await terminate(id)).status).toBe(500);
    expect(mocks.deleteInstance).not.toHaveBeenCalled();
    expect(mocks.charge).not.toHaveBeenCalled();
    expect(mocks.deleteMetadata).not.toHaveBeenCalled();
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

describe("termination stops the GPU before it settles or forgets anything", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.subscriptions.mockResolvedValue([{ id: instanceId, per_pod_info: { vgpu_count: 2 }, pods: [{ pod_status: "running" }] }]);
    mocks.metadata.mockResolvedValue(savedRate("per_instance"));
  });
  afterEach(() => vi.useRealTimers());

  it("credits nothing and keeps the record when hosted.ai refuses to delete a running GPU", async () => {
    mocks.deleteInstance.mockRejectedValueOnce(new Error("hosted.ai API error (500): busy"));
    mocks.detail.mockResolvedValue({ status: "running" });
    expect((await terminate(instanceId)).status).toBe(500);
    expect(mocks.charge).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.deleteMetadata).not.toHaveBeenCalled();
    expect(mocks.logTerminated).not.toHaveBeenCalled();
  });

  it("settles and forgets a GPU hosted.ai has already deleted (403)", async () => {
    mocks.deleteInstance.mockRejectedValueOnce(new Error("hosted.ai API error (403): you are not authorized"));
    mocks.detail.mockRejectedValue(new Error("hosted.ai API error (403): you are not authorized"));
    expect((await terminate(instanceId)).status).toBe(200);
    expect(mocks.charge).toHaveBeenCalledWith("cus_owner", expect.objectContaining({ amount: -300 }));
    expect(mocks.deleteMetadata).toHaveBeenCalledWith({ where: { id: "metadata" } });
  });

  it("credits unused time only after the GPU is deleted, and logs a failed credit for a manual one", async () => {
    const order: string[] = [];
    mocks.deleteInstance.mockImplementationOnce(async () => { order.push("delete GPU"); });
    mocks.charge.mockImplementationOnce(async () => { order.push("credit"); throw new Error("Stripe down"); });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await terminate(instanceId)).status).toBe(200);
    expect(order).toEqual(["delete GPU", "credit"]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("credit it by hand"), expect.any(Error));
  });

  it("charges overdue time before deleting the GPU, so a failed delete still leaves it paid up", async () => {
    mocks.metadata.mockResolvedValue(savedRate("per_instance", new Date("2030-01-01T00:00:00Z")));
    const order: string[] = [];
    mocks.charge.mockImplementationOnce(async () => { order.push("charge"); });
    mocks.deleteInstance.mockImplementationOnce(async () => { order.push("delete GPU"); throw new Error("hosted.ai API error (500): busy"); });
    mocks.detail.mockResolvedValue({ status: "running" });
    expect((await terminate(instanceId)).status).toBe(500);
    expect(order).toEqual(["charge", "delete GPU"]);
    expect(mocks.charge).toHaveBeenCalledWith("cus_owner", expect.objectContaining({ amount: 300 }));
    // Paid up to now; the billing run bills it on from here while it keeps running.
    expect(mocks.updateMetadata).toHaveBeenCalledWith(expect.objectContaining({ data: { prepaidUntil: now, prepaidAmountCents: 0 } }));
    expect(mocks.deleteMetadata).not.toHaveBeenCalled();
  });

  it("gives the overdue time back and keeps the GPU when the overdue charge fails", async () => {
    mocks.metadata.mockResolvedValue(savedRate("per_instance", new Date("2030-01-01T00:00:00Z")));
    mocks.charge.mockRejectedValueOnce(new Error("Stripe down"));
    expect((await terminate(instanceId)).status).toBe(500);
    expect(mocks.deleteInstance).not.toHaveBeenCalled();
    expect(mocks.updateMetadata).toHaveBeenLastCalledWith({
      where: { id: "metadata", prepaidUntil: now },
      data: { prepaidUntil: new Date("2030-01-01T00:00:00Z"), prepaidAmountCents: 600 },
    });
  });

  it("finishes a retry when Stripe says the same settlement was already made", async () => {
    mocks.charge.mockRejectedValueOnce(Object.assign(new Error("Keys for idempotent requests can only be used with the same parameters"), { type: "StripeIdempotencyError" }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await terminate(instanceId)).status).toBe(200);
    expect(logged).not.toHaveBeenCalledWith(expect.stringContaining("credit it by hand"), expect.anything());
    expect(mocks.deleteMetadata).toHaveBeenCalledWith({ where: { id: "metadata" } });
  });

  it("lists the team's GPUs before deleting, so a later 403 can only mean this GPU is gone", async () => {
    const order: string[] = [];
    mocks.subscriptions.mockImplementationOnce(async () => { order.push("list"); return []; });
    mocks.deleteInstance.mockImplementationOnce(async () => { order.push("delete GPU"); });
    expect((await terminate(instanceId)).status).toBe(200);
    expect(order).toEqual(["list", "delete GPU"]);
  });

  it("refuses a GPU with no hosted.ai instance id instead of calling the retired pool API", async () => {
    mocks.metadata.mockResolvedValue({ ...savedRate("per_gpu"), instanceId: null });
    const res = await terminate("12");
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("LEGACY_POOL_GPU");
    expect(mocks.deleteInstance).not.toHaveBeenCalled();
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
    expect(mocks.charge).not.toHaveBeenCalled();
  });
});
