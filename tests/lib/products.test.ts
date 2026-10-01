import { beforeEach, describe, expect, it, vi } from "vitest";
const products = vi.hoisted(() => vi.fn());
vi.mock("@/lib/prisma", () => ({ prisma: { gpuProduct: { findMany: products } } }));
import { getProductByPoolId } from "@/lib/products";

const legacy = { id: "legacy", name: "GPU", poolIds: "[12]", pricePerHourCents: 100, billingType: "hourly", serviceId: "service", configurationPricing: null };

describe("pool pricing fallback", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not infer configuration pricing from a GPU-only base rate", async () => {
    products.mockResolvedValue([{ ...legacy, configurationPricing: { cpuCoreHourCents: 1, ramGbHourCents: 1, rootGbHourCents: 0.1 } }]);
    expect(await getProductByPoolId(12)).toBeNull();
    expect(await getProductByPoolId(12, "legacy")).toBeNull();
  });

  it("requires an exact product when multiple products use the same pool", async () => {
    products.mockResolvedValue([legacy, { ...legacy, id: "other", pricePerHourCents: 200 }]);
    expect(await getProductByPoolId(12)).toBeNull();
    expect(await getProductByPoolId(12, "other")).toMatchObject({ id: "other", hourly_rate_cents: 200 });
    expect(await getProductByPoolId(12, "missing")).toBeNull();
  });

  it("never converts a monthly entitlement into an hourly rate", async () => {
    products.mockResolvedValue([{ ...legacy, billingType: "monthly" }]);
    expect(await getProductByPoolId(12)).toBeNull();
  });

  it("retains unambiguous historical fixed hourly pricing", async () => {
    products.mockResolvedValue([legacy]);
    expect(await getProductByPoolId("12")).toMatchObject({ id: "legacy", hourly_rate_cents: 100 });
  });
});
