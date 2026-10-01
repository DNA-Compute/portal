import { describe, expect, it } from "vitest";
import { canBackfillPodRate, getPodGpuCount, getPodHourlyRateCents, getPodStoppedHourlyRateCents } from "@/lib/pod-billing";
import { computeStoppedCharge } from "@/lib/stopped-billing";

const configured = {
  hourlyRateCents: 1234,
  hourlyRateBasis: "per_instance",
  billingType: "hourly",
  rateSnapshot: {
    version: 1,
    basis: "per_instance",
    instanceHourlyCents: 1234,
    totalHourlyCents: 1334,
    sharedStorageHourlyCents: 100,
    stoppedInstanceHourlyCents: 308.5,
    stoppedRatePercent: 25,
  },
};

describe("saved allocation pricing", () => {
  it("charges the complete two-GPU allocation once and excludes separately metered storage", () => {
    expect(getPodHourlyRateCents(configured, 2)).toBe(1234);
    expect(getPodHourlyRateCents({ hourlyRateCents: 1234, hourlyRateBasis: "per_gpu" }, 2)).toBe(2468);
    expect(getPodHourlyRateCents({ hourlyRateCents: 1234, hourlyRateBasis: null }, 2)).toBe(2468);
  });

  it("retains saved whole-GPU counts when native GPU VM pod_info is absent or stale", () => {
    expect(getPodGpuCount({ launchConfiguration: { gpuCount: 2 } })).toBe(2);
    expect(getPodGpuCount({ launchConfiguration: { gpuCount: 2 } }, 1)).toBe(2);
    expect(getPodGpuCount({ launchConfiguration: null }, 4)).toBe(4);
  });

  it("retains fractional captured stopped rates and rounds only the interval charge", () => {
    expect(getPodStoppedHourlyRateCents(configured, 2, 90)).toBe(308.5);
    expect(computeStoppedCharge([{ ...configured, gpuCount: 2 }], 90, 30))
      .toEqual({ stoppedGpuCount: 2, stoppedCostCents: 154 });
    expect(computeStoppedCharge([
      { ...configured, gpuCount: 2 },
      { hourlyRateCents: 1000, gpuCount: 2 },
    ], 50, 30)).toEqual({ stoppedGpuCount: 4, stoppedCostCents: 654 });
  });

  it("honors a zero captured stopped price instead of reverting to global pricing", () => {
    const freeStopped = { ...configured, rateSnapshot: { ...configured.rateSnapshot, stoppedInstanceHourlyCents: 0 } };
    expect(getPodStoppedHourlyRateCents(freeStopped, 2, 50)).toBe(0);
  });

  it("uses the captured percent when the snapshot has no stopped total", () => {
    const { stoppedInstanceHourlyCents: _, ...rateSnapshot } = configured.rateSnapshot;
    expect(getPodStoppedHourlyRateCents({ ...configured, rateSnapshot }, 2, 90)).toBe(308.5);
  });

  it("does not bill monthly allocations even if an old hourly field remains", () => {
    expect(getPodHourlyRateCents({ ...configured, billingType: "monthly" }, 2)).toBeNull();
    expect(computeStoppedCharge([{ ...configured, billingType: "monthly", gpuCount: 2 }], 50, 30).stoppedCostCents).toBe(0);
  });

  it("leaves missing or inconsistent configured prices unpriced rather than guessing", () => {
    expect(getPodHourlyRateCents({ ...configured, hourlyRateCents: null }, 2)).toBeNull();
    expect(getPodHourlyRateCents({ ...configured, rateSnapshot: null }, 2)).toBeNull();
    expect(getPodHourlyRateCents({ ...configured, hourlyRateCents: 100 }, 2)).toBeNull();
    expect(getPodHourlyRateCents({ ...configured, hourlyRateBasis: "per_gpu" }, 2)).toBeNull();
    expect(canBackfillPodRate({ ...configured, hourlyRateCents: null })).toBe(false);
    expect(canBackfillPodRate({ hourlyRateCents: null, launchConfiguration: { gpuCount: 2 } })).toBe(false);
    expect(canBackfillPodRate({ hourlyRateCents: null, hourlyRateBasis: null })).toBe(true);
  });
});
