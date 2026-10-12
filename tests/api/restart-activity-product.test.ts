import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The activity feed named the product for Stop, Start and Terminate ("on H100 fractional")
// but logged every Restart as "on GPU Instance".

const m = vi.hoisted(() => ({
  logGPURestarted: vi.fn(),
  findFirst: vi.fn(async () => ({ displayName: "box", productId: "prod-h100-frac" })),
  findUnique: vi.fn(async () => ({ name: "H100 fractional" })),
}));

vi.mock("@/lib/auth/helpers", () => ({
  getAuthenticatedCustomer: async () => ({ payload: { customerId: "cus_1" }, allTeamIds: ["team-1"] }),
}));
vi.mock("@/lib/auth/audit", () => ({ requirePermission: () => null }));
vi.mock("@/lib/auth/instance-ownership", () => ({
  canonicalInstanceId: (id: string) => id.replace(/^instance-/, ""),
  rejectUnownedInstance: async () => null,
}));
vi.mock("@/lib/hostedai", () => ({ restartInstance: vi.fn(async () => ({})), getInstanceCredentials: vi.fn() }));
vi.mock("@/lib/ssh-keys", () => ({ injectServerKeyIntoPod: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    installedApp: { deleteMany: vi.fn(async () => ({})) },
    podMetadata: { findFirst: m.findFirst },
    gpuProduct: { findUnique: m.findUnique },
  },
}));
vi.mock("@/lib/activity", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/activity")>()),
  logGPURestarted: m.logGPURestarted,
}));

import { POST } from "@/app/api/instances/pool-subscription/[id]/restart/route";

describe("Restart in the activity feed", () => {
  it("names the GPU's product, like Stop and Start do", async () => {
    vi.useFakeTimers();
    const response = await POST(new NextRequest("http://localhost/api/instances/pool-subscription/i-1/restart", { method: "POST" }),
      { params: Promise.resolve({ id: "i-1" }) });
    vi.useRealTimers();

    expect(response.status).toBe(200);
    expect(m.logGPURestarted).toHaveBeenCalledWith("cus_1", "H100 fractional", "box", "i-1");
  });
});
