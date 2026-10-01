import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  scale: vi.fn(),
  createVolume: vi.fn(),
  unsubscribe: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("@/lib/customer-auth", () => ({ verifyCustomerToken: () => ({ customerId: "cus_owner", email: "owner@example.com" }) }));
vi.mock("@/lib/auth/account-resolver", () => ({ resolveOperatingContext: async () => ({
  accountId: "cus_owner", customer: { email: "owner@example.com", metadata: { hostedai_team_id: "team" } },
}) }));
vi.mock("@/lib/auth/gate", () => ({ gatePermission: async () => null }));
vi.mock("@/lib/prisma", () => ({ prisma: { podMetadata: { findFirst: mocks.metadata } } }));
vi.mock("@/lib/activity", () => ({ logGPUScaled: vi.fn() }));
vi.mock("@/lib/hostedai", () => ({
  scalePoolSubscription: mocks.scale,
  getPoolSubscriptions: async () => [{ id: "instance", pool_id: "1", per_pod_info: { vgpu_count: 2 }, storage_details: {} }],
  getAllPools: async () => [{ id: 1, region_id: 1 }],
  getConnectionInfo: vi.fn(),
  getSharedVolumes: vi.fn().mockResolvedValue([]),
  getPoolInstanceTypes: vi.fn(),
  getPoolEphemeralStorageBlocks: vi.fn(),
  createSharedVolume: mocks.createVolume,
  unsubscribeFromPool: mocks.unsubscribe,
  subscribeToPool: mocks.subscribe,
}));
import { POST as scale } from "@/app/api/instances/pool-subscription/[id]/scale/route";
import { POST as snapshot } from "@/app/api/instances/pool-subscription/[id]/snapshot/route";

function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost/api/instances/pool-subscription/instance/${path}`, {
    method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("configured allocations reject unquoted resource replacements", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.metadata.mockResolvedValue({ hourlyRateBasis: "per_instance", launchConfiguration: { gpuCount: 2 } });
  });

  it("rejects legacy GPU scaling before the provider allocation changes", async () => {
    const result = await scale(request("scale", { vgpus: 1, pool_id: "1" }), { params: Promise.resolve({ id: "instance" }) });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: "REQUOTE_REQUIRED" });
    expect(mocks.scale).not.toHaveBeenCalled();
  });

  it("rejects snapshot auto-storage that would replace CPU/root allocation before creating a volume", async () => {
    const result = await snapshot(request("snapshot", { displayName: "Saved GPU", saveData: true, storageBlockId: "storage" }), { params: Promise.resolve({ id: "instance" }) });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: "REQUOTE_REQUIRED" });
    expect(mocks.createVolume).not.toHaveBeenCalled();
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
});
