import { describe, it, expect, vi, beforeEach } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { activityEvent: { create } } }));

import { gpuAllocationLabel } from "@/lib/launch-config";
import { logGPULaunched } from "@/lib/activity";

beforeEach(() => {
  create.mockReset();
  create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "event", createdAt: new Date(), ...data }));
});

describe("GPU allocation wording", () => {
  it("names a fractional launch by its share and whole GPUs by count", () => {
    expect(gpuAllocationLabel(1, 25)).toBe("25% GPU share");
    expect(gpuAllocationLabel(1)).toBe("1 GPU");
    expect(gpuAllocationLabel(1, 100)).toBe("1 GPU");
    expect(gpuAllocationLabel(2, 100)).toBe("2 GPUs");
  });

  it("records a fractional launch in the activity feed as a share, not one GPU", async () => {
    await logGPULaunched("cus", "B200 Shared", 1, "trainer", "instance", 50);
    expect(create.mock.calls[0][0].data.description).toBe('Launched 50% GPU share "trainer" on B200 Shared');
    expect(JSON.parse(create.mock.calls[0][0].data.metadata)).toMatchObject({ gpuCount: 1, gpuSharePercent: 50 });
    await logGPULaunched("cus", "H100", 2, "trainer", "instance");
    expect(create.mock.calls[1][0].data.description).toBe('Launched 2 GPUs "trainer" on H100');
  });
});
