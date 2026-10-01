import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  metadata: vi.fn(),
  pools: vi.fn(),
  snapshot: vi.fn(),
  debit: vi.fn(),
}));

vi.mock("@/lib/customer-auth", () => ({
  verifyCustomerToken: vi.fn().mockReturnValue({ customerId: "cus_restore", email: "owner@example.com" }),
  generateCustomerToken: vi.fn().mockReturnValue("dashboard-token"),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: vi.fn().mockResolvedValue({
    customers: {
      retrieve: vi.fn().mockResolvedValue({
        id: "cus_restore", email: "owner@example.com", metadata: { hostedai_team_id: "team" },
      }),
    },
  }),
}));
vi.mock("@/lib/hostedai", () => ({
  createInstance: mocks.create,
  getServiceProvisioningInfo: vi.fn().mockResolvedValue({
    instance_type_details: { default: { id: "profile" } },
    image_details: { default: { hash: "image" } },
    storage_block_details: { default: { id: "root100" } },
  }),
  getServiceCompatibleGPUPools: mocks.pools,
  getTeamWorkspaces: vi.fn().mockResolvedValue([{ id: "workspace", name: "Default" }]),
  getSharedVolumes: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    podSnapshot: {
      findFirst: mocks.snapshot,
    },
    podMetadata: { create: mocks.metadata },
    walletTransaction: { create: vi.fn().mockResolvedValue({}) },
  },
}));
vi.mock("@/lib/wallet", () => ({
  getWalletBalance: vi.fn().mockResolvedValue({ availableBalance: 1000 }),
  deductUsage: mocks.debit,
  refundDeployment: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/products", () => ({
  getProductByPoolId: vi.fn().mockResolvedValue({ name: "GPU", serviceId: "service", hourly_rate_cents: 100 }),
}));
vi.mock("@/lib/auth/gate", () => ({ gatePermission: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/activity", () => ({ logGPULaunched: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email", () => ({ sendGpuLaunchedEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/metrics-collector", () => ({ installMetricsCollector: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/startup-script-runner", () => ({ runStartupScript: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/startup-scripts", () => ({ WORKSPACE_SETUP_SCRIPT: "" }));

import { POST } from "@/app/api/instances/from-snapshot/[id]/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue("instance");
  mocks.metadata.mockResolvedValue({});
  mocks.pools.mockResolvedValue([{ id: 12, name: "Pool", available_vgpus: 4, pool_source: "owned", rootfs_persistence_capable: false }]);
  mocks.snapshot.mockResolvedValue({ id: "snapshot", poolId: "12", vgpus: 1, displayName: "Snapshot", regionId: "2", instanceTypeId: "profile" });
  mocks.debit.mockResolvedValue({ success: true });
});

describe("snapshot instance restore", () => {
  it.each([
    { name: "Owned", pools: [{ id: 12, name: "Owned", available_vgpus: 4, pool_source: "owned", rootfs_persistence_capable: false }] },
    { name: "Legacy marketplace", pools: [{ id: 12, name: "Legacy marketplace", available_vgpus: 4, pool_source: "marketplace" }] },
    { name: "Provider-selected pool", pools: [] },
  ])("retains persistence and the provider's string instance ID for $name", async ({ pools }) => {
    mocks.pools.mockResolvedValue(pools);
    const request = new NextRequest("http://localhost/api/instances/from-snapshot/snapshot", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ attachStorage: false }),
    });

    const response = await POST(request, { params: Promise.resolve({ id: "snapshot" }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, instance_id: "instance" });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      pod_opts: expect.objectContaining({ rootfs_enabled: true }),
    }));
    expect(mocks.metadata.mock.calls[0][0].data.instanceId).toBe("instance");
  });

  it("uses the selected pool's persistence capability rather than the first pool's", async () => {
    mocks.pools.mockResolvedValue([
      { id: 12, name: "Owned", available_vgpus: 1, pool_source: "owned", rootfs_persistence_capable: false },
      { id: 13, name: "Marketplace", available_vgpus: 4, pool_source: "marketplace", rootfs_persistence_capable: false },
    ]);
    const request = new NextRequest("http://localhost/api/instances/from-snapshot/snapshot", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ attachStorage: false }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: "snapshot" }) });
    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      pod_opts: expect.objectContaining({ pool_id: 13, rootfs_enabled: false }),
    }));
  });

  it("rejects an unsupported snapshot volume attachment before charging or creating an instance", async () => {
    mocks.snapshot.mockResolvedValue({ id: "snapshot", poolId: "12", vgpus: 1, displayName: "Snapshot", regionId: "2", instanceTypeId: "profile", persistentVolumeId: 91 });
    mocks.pools.mockResolvedValue([{ id: 12, name: "Marketplace", available_vgpus: 4, pool_source: "marketplace", shared_storage_capable: false }]);
    const request = new NextRequest("http://localhost/api/instances/from-snapshot/snapshot", {
      method: "POST",
      headers: { authorization: "Bearer token", "content-type": "application/json" },
      body: JSON.stringify({ attachStorage: true }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: "snapshot" }) });
    expect(response.status).toBe(409);
    expect(mocks.debit).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
