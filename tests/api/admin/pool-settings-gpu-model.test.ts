import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getAllPools: vi.fn(),
  listClusters: vi.fn(),
  listPools: vi.fn(),
}));

vi.mock("@/lib/admin", () => ({ verifySessionToken: () => ({ email: "admin@example.com" }) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    poolSettingsDefaults: { findUnique: async () => ({ timeQuantumSec: 90, overcommitRatio: 1, securityMode: "low" }) },
    poolSettingsOverride: { findMany: async () => [] },
  },
}));
vi.mock("@/lib/hostedai", () => ({ getAllPools: mocks.getAllPools }));
vi.mock("@/lib/gpuaas-admin", () => ({ gpuaasAdmin: { listClusters: mocks.listClusters, listPools: mocks.listPools } }));
vi.mock("@/lib/admin-activity", () => ({ logSettingsUpdated: vi.fn() }));

import { GET } from "@/app/api/admin/pool-settings/route";

const request = () => new NextRequest("http://localhost/api/admin/pool-settings", {
  headers: { cookie: "admin_session=session" },
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  // getAllPools has no GPU model to report, so it repeats the pool label in gpu_model.
  mocks.getAllPools.mockResolvedValue([
    { id: "15", name: "US-West-B200", gpu_model: "US-West-B200", region_id: 9 },
    { id: "16", name: "US-West-L40S", gpu_model: "US-West-L40S", region_id: 9 },
  ]);
  mocks.listClusters.mockResolvedValue([{ id: 1, status: "GPUAAS_ACTIVE", region_id: 3 }]);
  mocks.listPools.mockResolvedValue([
    { id: 15, name: "US-West-B200", gpu_model_type: "B200" },
    { id: 16, name: "US-West-L40S" },
    { id: 21, name: "tokyo-h100", gpu_model_type: "H100" },
    { id: 22, name: "tokyo-misc" },
  ]);
});

describe("admin pool list GPU model", () => {
  it("reports a GPU model only when hosted.ai gives one, never the pool name", async () => {
    const body = await (await GET(request())).json();
    expect(body.data.availablePools.map((p: { id: number; gpuModel?: string }) => [p.id, p.gpuModel ?? null])).toEqual([
      [15, "B200"],
      [16, null],
      [21, "H100"],
      [22, null],
    ]);
  });
});
