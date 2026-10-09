import { describe, expect, it } from "vitest";
import { calculateLaunchRate, LaunchPricingError, quoteResolvedConfiguration } from "../../src/lib/launch-pricing";
import { configuredLaunchSchema, type ResolvedLaunchConfiguration } from "../../src/lib/launch-config";
import { getPodHourlyRateCents, getPodStoppedHourlyRateCents } from "../../src/lib/pod-billing";

function allocation(): ResolvedLaunchConfiguration {
  return {
    configuration: {
      productId: "gpu-offering", regionId: 1, instanceTypeId: "8cpu-32gb", imageHash: "ubuntu-image",
      rootStorageBlockId: "root-200", gpuCount: 2, poolId: 12,
      storage: { mode: "new", blockId: "shared-100" }, software: { kind: "none" },
    },
    serviceId: "gpu-service", serviceType: "pod_accelerator", productName: "GPU offering", billingType: "hourly",
    gpuBaseHourCents: 200,
    configurationPricing: { cpuCoreHourCents: 3, ramGbHourCents: 0.5, rootGbHourCents: 0.01 },
    profile: { id: "8cpu-32gb", name: "8 vCPU / 32 GB", cpuCores: 8, ramGb: 32 },
    image: { id: "ubuntu-image", name: "Ubuntu" },
    rootStorage: { id: "root-200", name: "200 GB root disk", sizeGb: 200 },
    sharedStorage: { blockId: "shared-100", name: "100 GB persistent disk", sizeGb: 100 },
    gpuName: "GPU", gpuVramGb: 80,
  };
}

describe("Configured launch pricing", () => {
  it("prices GPU quantity but CPU/RAM/root once, with shared storage outside prepayment", () => {
    const rate = calculateLaunchRate(allocation(), 0.003, 25);
    expect(rate.instanceHourlyCents).toBe(442); // 2×200 + 8×3 + 32×0.5 + 200×0.01
    expect(rate.sharedStorageHourlyCents).toBeCloseTo(0.3);
    expect(rate.totalHourlyCents).toBeCloseTo(442.3);
    expect(rate.prepayCents).toBe(221);
    expect(rate.stoppedInstanceHourlyCents).toBe(110.5);
    expect(rate.lines.filter(line => !line.separatelyMetered).reduce((sum, line) => sum + line.hourlyCents, 0)).toBe(rate.instanceHourlyCents);
  });

  it("meters a persisted multi-GPU quote once and retains its accepted stopped price", () => {
    const resolved = allocation();
    const quote = quoteResolvedConfiguration(resolved, "account", "team", 0.003, 25);
    const persisted = JSON.parse(JSON.stringify({
      hourlyRateCents: quote.rate.instanceHourlyCents,
      hourlyRateBasis: "per_instance",
      launchConfiguration: quote.configuration,
      rateSnapshot: quote.rate,
    }));
    const running = getPodHourlyRateCents(persisted, resolved.configuration.gpuCount);
    const stopped = getPodStoppedHourlyRateCents(persisted, resolved.configuration.gpuCount, 99);
    expect(running).toBe(quote.rate.instanceHourlyCents);
    expect(stopped).toBe(quote.rate.stoppedInstanceHourlyCents);
    expect(running! + quote.rate.sharedStorageHourlyCents).toBeCloseTo(quote.rate.totalHourlyCents, 6);
    expect(quote.rate.prepayCents).toBe(Math.round(running! * quote.rate.minimumBillingMinutes / 60));
    expect(quoteResolvedConfiguration(resolved, "account", "team", 0.003, 25).fingerprint).toBe(quote.fingerprint);
  });

  it("bills a guaranteed GPU share as that fraction of the GPU rate, and only from a rate card", () => {
    const resolved = allocation();
    resolved.configuration = { ...resolved.configuration, gpuCount: 1, gpuSharePercent: 25 };
    resolved.podOptions = { rootfsEnabled: true, gpuShare: { percent: 25, guaranteed: true } };
    expect(() => calculateLaunchRate(resolved, 0.003, 25)).toThrow(LaunchPricingError); // rate card has not opted in
    resolved.configurationPricing = { ...resolved.configurationPricing!, fractionalGpu: true };
    const rate = calculateLaunchRate(resolved, 0.003, 25);
    expect(rate.lines[0]).toMatchObject({ label: "GPU (25% guaranteed share)", quantity: 0.25, hourlyCents: 50 });
    expect(rate.instanceHourlyCents).toBe(92); // 0.25×200 + 8×3 + 32×0.5 + 200×0.01
    expect(() => calculateLaunchRate({ ...resolved, configurationPricing: null }, 0.003, 25)).toThrow(LaunchPricingError);
    expect(() => calculateLaunchRate({ ...resolved, configuration: { ...resolved.configuration, gpuCount: 2 } }, 0.003, 25)).toThrow(LaunchPricingError);
  });

  it("quotes the rounded hourly components that the instance meter will actually charge", () => {
    const resolved = allocation();
    resolved.configurationPricing = { cpuCoreHourCents: 0.2, ramGbHourCents: 0.02, rootGbHourCents: 0.003 };
    const rate = calculateLaunchRate(resolved, 0.003, 25);
    expect(rate.lines.filter(line => !line.separatelyMetered).map(line => line.hourlyCents)).toEqual([400, 2, 1, 1]);
    expect(rate.instanceHourlyCents).toBe(404);
    expect(rate.prepayCents).toBe(202);
  });

  it("does not charge CPU/RAM/root again for a prepaid monthly entitlement", () => {
    const resolved = allocation();
    resolved.billingType = "monthly";
    resolved.configurationPricing = null;
    const rate = calculateLaunchRate(resolved, 0.003, 25);
    expect(rate.instanceHourlyCents).toBe(0);
    expect(rate.prepayCents).toBe(0);
    expect(rate.stoppedInstanceHourlyCents).toBe(0);
    expect(rate.totalHourlyCents).toBeCloseTo(0.3);
    expect(rate.lines.filter(line => line.hourlyCents > 0).map(line => line.key)).toEqual(["shared"]);
  });

  it("rejects an incomplete resource rate card rather than silently making RAM free", () => {
    const resolved = allocation();
    Reflect.deleteProperty(resolved.configurationPricing!, "ramGbHourCents");
    expect(() => calculateLaunchRate(resolved, 0.003, 25)).toThrow(LaunchPricingError);
  });

  it("rejects a zero-priced hourly allocation even when a storage fee exists", () => {
    const resolved = allocation();
    resolved.gpuBaseHourCents = 0;
    resolved.configurationPricing = { cpuCoreHourCents: 0, ramGbHourCents: 0, rootGbHourCents: 0 };
    expect(() => calculateLaunchRate(resolved, 1, 25)).toThrow(LaunchPricingError);
  });

  it("rejects totals that cannot be persisted in the database money column", () => {
    const resolved = allocation();
    resolved.gpuBaseHourCents = 2_147_483_647;
    expect(() => calculateLaunchRate(resolved, 0.003, 25)).toThrow(LaunchPricingError);
  });

  it("binds a quote to its account and team", () => {
    const resolved = allocation();
    const quote = quoteResolvedConfiguration(resolved, "account-a", "team-a", 0.003, 25);
    expect(quoteResolvedConfiguration(resolved, "account-b", "team-a", 0.003, 25).fingerprint).not.toBe(quote.fingerprint);
    expect(quoteResolvedConfiguration(resolved, "account-a", "team-b", 0.003, 25).fingerprint).not.toBe(quote.fingerprint);
  });

  it("requires a new quote when the selected allocation or storage rate changes", () => {
    const resolved = allocation();
    const quote = quoteResolvedConfiguration(resolved, "account", "team", 0.003, 25);
    expect(quoteResolvedConfiguration(resolved, "account", "team", 0.004, 25).fingerprint).not.toBe(quote.fingerprint);
    resolved.profile = { ...resolved.profile, cpuCores: 16 };
    expect(quoteResolvedConfiguration(resolved, "account", "team", 0.003, 25).fingerprint).not.toBe(quote.fingerprint);
  });

  it("requires quote review if root persistence changes without changing price", () => {
    const resolved = allocation();
    resolved.podOptions = { rootfsEnabled: true };
    const persistent = quoteResolvedConfiguration(resolved, "account", "team", 0.003, 25);
    resolved.podOptions = { rootfsEnabled: false };
    const ephemeral = quoteResolvedConfiguration(resolved, "account", "team", 0.003, 25);
    expect(ephemeral.rate).toEqual(persistent.rate);
    expect(ephemeral.fingerprint).not.toBe(persistent.fingerprint);
  });

  it("never includes model tokens in quotes and does not bind prices to credentials", () => {
    const resolved = allocation();
    resolved.configuration.software = { kind: "huggingface", hfItemId: "model", hfToken: "hf_TEST_ONLY_ONE" };
    const first = quoteResolvedConfiguration(resolved, "account", "team", 0.003, 25);
    expect(JSON.stringify(first)).not.toContain("hf_TEST_ONLY_ONE");
    resolved.configuration.software.hfToken = "hf_TEST_ONLY_TWO";
    expect(quoteResolvedConfiguration(resolved, "account", "team", 0.003, 25).fingerprint).toBe(first.fingerprint);
  });

  it("does not duplicate custom startup script credentials into saved quote data", () => {
    const resolved = allocation();
    resolved.configuration.software = { kind: "startup", script: "export API_TOKEN=TEST_ONLY_SCRIPT_SECRET" };
    expect(JSON.stringify(quoteResolvedConfiguration(resolved, "account", "team", 0.003, 25))).not.toContain("TEST_ONLY_SCRIPT_SECRET");
  });

  it("rejects browser-supplied resource dimensions or prices at the launch boundary", () => {
    const result = configuredLaunchSchema.safeParse({
      configuration: { ...allocation().configuration, cpuCores: 999, hourlyRateCents: 1 },
      quoteFingerprint: "a".repeat(64), name: "example", sshKeyIds: [],
    });
    expect(result.success).toBe(false);
  });
});
