import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LaunchConfigurator } from "@/app/dashboard/components/LaunchConfigurator";
import type { LaunchCapabilities } from "@/lib/launch-config";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe("GPU configuration availability", () => {
  it("settles an unavailable region instead of oscillating GPU quantity, then allows selecting an available region", async () => {
    const regions = [{ id: 1, name: "Unavailable" }, { id: 2, name: "Available" }];
    const empty: LaunchCapabilities = {
      productId: "gpu", serviceType: "pod_accelerator", regions,
      profiles: [], images: [], rootStorageBlocks: [], sharedStorageBlocks: [], volumes: [], pools: [], gpuModels: [],
      maxGpuCount: 0, defaults: { gpuCount: 1 }, includedAllocation: { gpuCount: 1 },
      locks: { profile: false, image: false, rootStorage: false, pool: false, gpuCount: false },
    };
    const available: LaunchCapabilities = {
      ...empty, regionId: 2, maxGpuCount: 2,
      defaults: { gpuCount: 1, poolId: 4, instanceTypeId: "cpu", imageHash: "ubuntu", rootStorageBlockId: "root" },
      profiles: [{ id: "cpu", name: "CPU", cpuCores: 4, ramGb: 8 }],
      images: [{ id: "ubuntu", name: "Ubuntu" }],
      rootStorageBlocks: [{ id: "root", name: "Root", sizeGb: 100 }],
      pools: [{ id: 4, name: "GPU pool", maxGpuCount: 2, rootfsEnabled: true, sharedStorageEnabled: false }],
    };
    let emptyRegionRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/instances/launch-options") return Response.json({
        products: [{ id: "gpu", name: "GPU", gpuFamily: "GPU", billingType: "hourly", configurationPricing: null, vramGb: null }],
        sshKeys: [], teamId: "team", walletBalanceCents: 0,
      });
      if (url.pathname === "/api/account/wallet-topup") return Response.json({ amounts: [] });
      if (url.pathname === "/api/instances/configuration") {
        const regionId = Number(url.searchParams.get("region_id"));
        // Bound a broken render loop with a pending request, rather than hanging the test runner.
        if (regionId === 1 && ++emptyRegionRequests > 8) return new Promise<Response>(() => {});
        return Response.json({ capabilities: regionId === 2 ? available : {
          ...empty, regionId: regionId || undefined, defaults: regionId ? empty.defaults : {},
        } });
      }
      if (url.pathname === "/api/instances/quote") return Response.json({ error: "Resource rates unavailable" }, { status: 422 });
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));

    await act(async () => {
      render(<LaunchConfigurator isOpen token="local-session" onClose={vi.fn()} onSuccess={vi.fn()} />);
    });
    expect(emptyRegionRequests).toBeLessThanOrEqual(2);
    const region = screen.getByRole("combobox", { name: "Region" });
    expect(region).toHaveValue("1");
    expect(region).toBeEnabled();

    await act(async () => { fireEvent.change(region, { target: { value: "2" } }); });
    expect(region).toHaveValue("2");
    expect(region).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("spinbutton", { name: /Whole GPUs/ })).toHaveValue(1);
    expect(screen.getByRole("combobox", { name: /CPU & RAM profile/ })).toHaveValue("cpu");
  });
});
