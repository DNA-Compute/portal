import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LaunchConfigurator } from "@/app/dashboard/components/LaunchConfigurator";
import type { LaunchCapabilities, LaunchQuote } from "@/lib/launch-config";

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
    expect(screen.getByRole("radio", { name: "Unavailable" })).toBeChecked();
    const region = screen.getByRole("radio", { name: "Available" });
    expect(region).toBeEnabled();

    await act(async () => { fireEvent.click(region); });
    expect(region).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("spinbutton", { name: /Whole GPUs/ })).toHaveValue(1);
    expect(screen.getByRole("combobox", { name: /CPU & RAM profile/ })).toHaveValue("cpu");
  });

  it("reports a fully booked GPU without also claiming to still check its regions", async () => {
    const message = "This GPU offering is unavailable for your account right now. It may be fully booked, so try again later or contact support.";
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/instances/launch-options") return Response.json({
        products: [{ id: "gpu", name: "GPU", gpuFamily: "GPU", billingType: "hourly", configurationPricing: null, vramGb: null }],
        sshKeys: [], teamId: "team", walletBalanceCents: 0,
      });
      if (url.pathname === "/api/account/wallet-topup") return Response.json({ amounts: [] });
      if (url.pathname === "/api/instances/configuration") return Response.json({ error: message, code: "SERVICE_NOT_PERMITTED" }, { status: 403 });
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));

    await act(async () => {
      render(<LaunchConfigurator isOpen token="local-session" onClose={vi.fn()} onSuccess={vi.fn()} />);
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByText("Checking where this GPU is available…")).toBeNull();
    expect(screen.getByText("No region is available for this GPU right now.")).toBeInTheDocument();
  });

  it("shows a readable error when a proxy answers with an HTML error page instead of JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/api/instances/launch-options") return Response.json({
        products: [{ id: "gpu", name: "GPU", gpuFamily: "GPU", billingType: "hourly", configurationPricing: null, vramGb: null }],
        sshKeys: [], teamId: "team", walletBalanceCents: 0,
      });
      if (url.pathname === "/api/account/wallet-topup") return Response.json({ amounts: [] });
      // Cloudflare replaces an origin 502 with its own HTML page.
      if (url.pathname === "/api/instances/configuration") return new Response("<!DOCTYPE html><title>502 Bad gateway</title>", { status: 502, headers: { "Content-Type": "text/html" } });
      throw new Error(`Unexpected request: ${url.pathname}`);
    }));

    await act(async () => {
      render(<LaunchConfigurator isOpen token="local-session" onClose={vi.fn()} onSuccess={vi.fn()} />);
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Unable to load supported resources");
    expect(alert).not.toHaveTextContent(/Unexpected token|JSON/);
  });

  describe("the review step", () => {
    const capabilities: LaunchCapabilities = {
      productId: "gpu", serviceType: "pod_accelerator", regions: [{ id: 2, name: "Los Angeles" }], regionId: 2,
      profiles: [{ id: "cpu", name: "CPU", cpuCores: 4, ramGb: 8 }], images: [{ id: "ubuntu", name: "Ubuntu" }],
      rootStorageBlocks: [{ id: "root", name: "Root", sizeGb: 100 }], sharedStorageBlocks: [], volumes: [], gpuModels: [],
      pools: [{ id: 4, name: "GPU pool", maxGpuCount: 1, rootfsEnabled: true, sharedStorageEnabled: false }],
      maxGpuCount: 1, defaults: { gpuCount: 1, poolId: 4, instanceTypeId: "cpu", imageHash: "ubuntu", rootStorageBlockId: "root" },
      includedAllocation: { gpuCount: 1 }, locks: { profile: false, image: false, rootStorage: false, pool: false, gpuCount: false },
    };
    const quote = {
      fingerprint: "quote-1", warnings: [],
      rate: { instanceHourlyCents: 360, sharedStorageHourlyCents: 0, totalHourlyCents: 360, stoppedInstanceHourlyCents: 90, stoppedRatePercent: 25,
        minimumBillingMinutes: 30, prepayCents: 180, lines: [{ key: "gpu", label: "GPU", quantity: 1, unit: "GPU", unitRateCents: 360, hourlyCents: 360, separatelyMetered: false }] },
    } as unknown as LaunchQuote;

    async function openReview(launchResponse: () => Response) {
      const launches: unknown[] = [];
      vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
        const url = new URL(input, "http://localhost");
        if (url.pathname === "/api/instances/launch-options") return Response.json({
          products: [{ id: "gpu", name: "GPU", gpuFamily: "GPU", billingType: "hourly", configurationPricing: null, vramGb: null }],
          sshKeys: [], teamId: "team", walletBalanceCents: 10_000,
        });
        if (url.pathname === "/api/account/wallet-topup") return Response.json({ amounts: [] });
        if (url.pathname === "/api/instances/configuration") return Response.json({ capabilities });
        if (url.pathname === "/api/instances/quote") return Response.json({ quote });
        if (url.pathname === "/api/instances" && init?.method === "POST") { launches.push(init.body); return launchResponse(); }
        return Response.json({ items: [] });
      }));
      const onSuccess = vi.fn();
      await act(async () => {
        render(<LaunchConfigurator isOpen token="local-session" onClose={vi.fn()} onSuccess={onSuccess} />);
      });
      const next = async () => {
        const button = screen.getByRole("button", { name: "Continue" });
        await waitFor(() => expect(button).toBeEnabled());
        await act(async () => { fireEvent.click(button); });
      };
      await next(); await next(); await next();
      fireEvent.change(screen.getByPlaceholderText("training-workspace"), { target: { value: "box" } });
      await next();
      return { launches, onSuccess };
    }

    it("points to the review checkbox while it is the only thing holding back launch", async () => {
      await openReview(() => Response.json({ instance_id: "i-1" }));
      const reviewed = screen.getByRole("checkbox", { name: /I have reviewed this configuration/ });
      expect(screen.getByRole("button", { name: "Launch GPU" })).toBeDisabled();

      fireEvent.click(screen.getByRole("button", { name: /Tick the price review to launch/ }));
      expect(reviewed).toHaveFocus();

      fireEvent.click(reviewed);
      expect(screen.getByRole("button", { name: "Launch GPU" })).toBeEnabled();
      expect(screen.queryByRole("button", { name: /Tick the price review to launch/ })).toBeNull();
    });

    it("does not report success when a proxy answers the launch with an HTML page, and asks for a fresh review before retrying", async () => {
      const { launches, onSuccess } = await openReview(() => new Response("<!DOCTYPE html><title>A timeout occurred</title>", { status: 200, headers: { "Content-Type": "text/html" } }));
      fireEvent.click(screen.getByRole("checkbox", { name: /I have reviewed this configuration/ }));
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Launch GPU" })); });

      expect(launches).toHaveLength(1);
      expect(onSuccess).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent("We could not confirm whether this GPU launched");
      // The launch may have gone through, so a second click must not silently start another GPU.
      expect(screen.getByRole("checkbox", { name: /I have reviewed this configuration/ })).not.toBeChecked();
      expect(screen.getByRole("button", { name: "Launch GPU" })).toBeDisabled();
    });
  });
});
