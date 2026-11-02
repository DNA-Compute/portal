import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Admin Terminate and "save snapshot and terminate" used to call the retired pool unsubscribe with
// an instance id it turned into NaN: the GPU kept running while the response said it was gone.
// Both now go through terminateGpu, like the customer's Terminate.

const instanceId = "i-22222222-2222-2222-2222-222222222222";
const mocks = vi.hoisted(() => ({
  deleteInstance: vi.fn(),
  detail: vi.fn(),
  subscriptions: vi.fn(),
  unsubscribe: vi.fn(),
  metadata: vi.fn(),
  deleteMetadata: vi.fn().mockResolvedValue({}),
  charge: vi.fn().mockResolvedValue({}),
  snapshotCreate: vi.fn(),
  logTerminated: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/admin", () => ({ verifySessionToken: () => ({ email: "admin@example.com" }) }));
vi.mock("@/lib/admin-activity", () => ({ logAdminActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/customer-auth", () => ({ verifyCustomerToken: () => ({ customerId: "cus_owner", email: "owner@example.com" }) }));
vi.mock("@/lib/auth/gate", () => ({ gatePermission: async () => null }));
vi.mock("@/lib/auth/account-resolver", () => ({ resolveOperatingContext: async () => ({
  accountId: "cus_owner",
  customer: { id: "cus_owner", email: "owner@example.com", metadata: { hostedai_team_id: "team" } },
}) }));
vi.mock("@/lib/auth/instance-ownership", () => ({ rejectUnownedInstance: async () => null }));
vi.mock("@/lib/activity", () => ({ logGPUTerminated: mocks.logTerminated, instanceProductName: async () => "H100" }));
vi.mock("@/lib/stripe", () => ({ getStripe: async () => ({ customers: { createBalanceTransaction: mocks.charge } }) }));
vi.mock("@/lib/pricing", () => ({ getStoppedInstanceRatePercent: () => 25 }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  podMetadata: {
    findFirst: mocks.metadata,
    findUnique: mocks.metadata,
    delete: mocks.deleteMetadata,
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  podSnapshot: { create: mocks.snapshotCreate },
  huggingFaceDeployment: { findFirst: vi.fn().mockResolvedValue(null) },
} }));
vi.mock("@/lib/hostedai", () => ({
  deleteInstance: mocks.deleteInstance,
  getUnifiedInstanceDetail: mocks.detail,
  getPoolSubscriptions: mocks.subscriptions,
  unsubscribeFromPool: mocks.unsubscribe,
  podAction: vi.fn(),
  getConnectionInfo: vi.fn(),
  getAllPools: vi.fn().mockResolvedValue([]),
  createSharedVolume: vi.fn(),
  subscribeToPool: vi.fn(),
  getPoolEphemeralStorageBlocks: vi.fn(),
  getSharedVolumes: vi.fn().mockResolvedValue([]),
  getPoolInstanceTypes: vi.fn(),
}));

import { POST as adminAction } from "@/app/api/admin/pods/[id]/route";
import { POST as createSnapshot } from "@/app/api/instances/pool-subscription/[id]/snapshot/route";

// An hourly GPU 15 minutes into a paid half hour of $6.00/hr: $3.00 paid, $1.50 unused.
function hourlyRecord() {
  const now = Date.now();
  return {
    id: "metadata", subscriptionId: `instance-${instanceId}`, instanceId, stripeCustomerId: "cus_owner",
    billingType: "hourly", hourlyRateCents: 600, hourlyRateBasis: null, launchConfiguration: null, rateSnapshot: null,
    prepaidUntil: new Date(now + 15 * 60_000), prepaidAmountCents: 300, displayName: "GPU", productId: "p",
  };
}

function adminTerminate() {
  return adminAction(new NextRequest(`http://localhost/api/admin/pods/${instanceId}`, {
    method: "POST",
    headers: { cookie: "admin_session=s" },
    body: JSON.stringify({ action: "terminate", teamId: "team" }),
  }), { params: Promise.resolve({ id: instanceId }) });
}

function snapshotAndTerminate() {
  return createSnapshot(new NextRequest(`http://localhost/api/instances/pool-subscription/${instanceId}/snapshot`, {
    method: "POST",
    headers: { authorization: "Bearer t" },
    body: JSON.stringify({ displayName: "keep", terminateAfterSave: true }),
  }), { params: Promise.resolve({ id: instanceId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.metadata.mockResolvedValue(hourlyRecord());
  mocks.deleteInstance.mockResolvedValue(undefined);
  mocks.subscriptions.mockResolvedValue([
    { id: "other", pool_id: 1, status: "subscribed", pods: [{ pod_status: "running" }] },
    { id: instanceId, pool_id: 1, status: "subscribed", per_pod_info: { vgpu_count: 1 }, pods: [{ pod_status: "running" }] },
  ]);
  mocks.snapshotCreate.mockResolvedValue({ id: "snap", displayName: "keep", snapshotType: "template" });
});

describe("admin Terminate", () => {
  it("deletes the GPU in hosted.ai, credits the paying account once and forgets the record", async () => {
    expect((await adminTerminate()).status).toBe(200);
    expect(mocks.deleteInstance).toHaveBeenCalledWith(instanceId);
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
    expect(mocks.charge).toHaveBeenCalledWith("cus_owner", expect.objectContaining({ amount: -150 }), { idempotencyKey: "settle_metadata" });
    expect(mocks.deleteMetadata).toHaveBeenCalledWith({ where: { id: "metadata" } });
  });

  it("reports the failure and keeps the record when hosted.ai won't stop the GPU", async () => {
    mocks.deleteInstance.mockRejectedValueOnce(new Error("hosted.ai API error (500): busy"));
    mocks.detail.mockResolvedValue({ status: "running" });
    expect((await adminTerminate()).status).toBe(500);
    expect(mocks.charge).not.toHaveBeenCalled();
    expect(mocks.deleteMetadata).not.toHaveBeenCalled();
  });
});

describe("save snapshot and terminate", () => {
  it("ends this GPU, not the first one in the same pool, and settles it", async () => {
    const res = await snapshotAndTerminate();
    expect(res.status).toBe(200);
    expect((await res.json()).terminated).toBe(true);
    expect(mocks.deleteInstance).toHaveBeenCalledTimes(1);
    expect(mocks.deleteInstance).toHaveBeenCalledWith(instanceId);
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
    expect(mocks.charge).toHaveBeenCalledWith("cus_owner", expect.objectContaining({ amount: -150 }), { idempotencyKey: "settle_metadata" });
    expect(mocks.logTerminated).toHaveBeenCalledWith("cus_owner", "H100", "GPU", instanceId);
  });

  it("says the GPU is still running when the stop fails, while keeping the saved snapshot", async () => {
    mocks.deleteInstance.mockRejectedValueOnce(new Error("hosted.ai API error (500): busy"));
    mocks.detail.mockResolvedValue({ status: "running" });
    const res = await snapshotAndTerminate();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.snapshot.id).toBe("snap");
    expect(body.terminated).toBe(false);
    expect(body.terminateError).toMatch(/could not be stopped/);
    expect(mocks.deleteMetadata).not.toHaveBeenCalled();
  });
});
