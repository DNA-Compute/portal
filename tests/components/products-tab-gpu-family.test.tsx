import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProductsTab } from "@/app/admin/components/ProductsTab";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const product = {
  id: "b200", name: "B200", description: null, billingType: "hourly", pricePerHourCents: 610,
  pricePerMonthCents: null, configurationPricing: null, stripeProductId: null, stripePriceId: null,
  poolIds: [], serviceId: null, categoryIds: [], displayOrder: 0, active: true, featured: false,
  badgeText: null, vramGb: 192, cudaCores: null, gpuFamily: "B200",
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
};

function stubAdminApi(pools: Array<{ id: number; name: string; gpuModel?: string }>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/admin/gpu-products") return Response.json({ success: true, data: [product], categories: [] });
    if (url.pathname === "/api/admin/pool-settings") return Response.json({ success: true, data: { availablePools: pools } });
    if (url.pathname === "/api/admin/pricing") return Response.json({});
    throw new Error(`Unexpected request: ${url.pathname}`);
  }));
}

async function openEditor() {
  await act(async () => { render(<ProductsTab />); });
  await act(async () => { fireEvent.click(await screen.findByTitle("Edit")); });
  return screen.getByLabelText("GPU Family") as HTMLInputElement;
}

describe("product GPU family", () => {
  it("keeps the family an admin set when a pool is assigned", async () => {
    stubAdminApi([{ id: 15, name: "US-West-B200", gpuModel: "B200 SXM" }]);
    const family = await openEditor();
    fireEvent.click(screen.getByRole("checkbox", { name: /US-West-B200/ }));
    expect(family.value).toBe("B200");
  });

  it("fills an empty family from the first assigned pool's GPU model", async () => {
    stubAdminApi([{ id: 15, name: "US-West-B200", gpuModel: "B200" }]);
    const family = await openEditor();
    fireEvent.change(family, { target: { value: "" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /US-West-B200/ }));
    expect(family.value).toBe("B200");
  });
});
