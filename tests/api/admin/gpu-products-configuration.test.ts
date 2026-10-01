import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  verifySessionToken: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  hostedaiRequest: vi.fn(),
  getHAIService: vi.fn(),
  updateHAIService: vi.fn(),
}));

vi.mock("@/lib/admin", () => ({ verifySessionToken: mocks.verifySessionToken }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    gpuProduct: {
      findFirst: mocks.findFirst,
      findUnique: mocks.findUnique,
      create: mocks.create,
      update: mocks.update,
    },
  },
}));
vi.mock("@/lib/hostedai", () => ({
  hostedaiRequest: mocks.hostedaiRequest,
  getHAIService: mocks.getHAIService,
  updateHAIService: mocks.updateHAIService,
}));
vi.mock("@/lib/hostedai/client", () => ({ clearCache: vi.fn() }));
vi.mock("@/lib/scenarios", () => ({
  assignGpuService: vi.fn(),
  createCategoryScenario: vi.fn(),
  syncServiceScenarios: vi.fn(),
}));

import { POST } from "@/app/api/admin/gpu-products/route";
import { GET as listServices } from "@/app/api/admin/hai-services/route";

const rates = { cpuCoreHourCents: 1.25, ramGbHourCents: 0.2, rootGbHourCents: 0 };
const existing = {
  id: "product-1",
  name: "GPU family",
  billingType: "hourly",
  pricePerHourCents: 250,
  pricePerMonthCents: null,
  configurationPricing: rates,
  serviceId: "service-1",
  poolIds: "[1]",
  categories: [],
  active: true,
  stripeProductId: null,
  stripePriceId: null,
};
const unlockedService = {
  id: "service-1",
  name: "Configurable GPU",
  service_type: "pod_accelerator",
  is_enabled: true,
  gpu_config: { default_gpu_pools: [1], default_gpu_model_id: "gpu-model-1" },
  instance_config: {
    default_instance_type_id: "profile-1",
    default_storage_block_id: "disk-1",
    default_image_hash_id: "image-1",
    instance_type_locked: false,
    storage_block_locked: false,
    image_locked: false,
    auto_assign_network: "both",
  },
};

function request(body: unknown) {
  return new NextRequest("http://localhost/api/admin/gpu-products", {
    method: "POST",
    headers: { cookie: "admin_session=valid", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifySessionToken.mockReturnValue({ email: "admin@example.com" });
  mocks.findFirst.mockResolvedValue(null);
  mocks.findUnique.mockResolvedValue(existing);
  mocks.create.mockResolvedValue(existing);
  mocks.update.mockResolvedValue(existing);
  mocks.hostedaiRequest.mockResolvedValue(unlockedService);
});

describe("GPU offering rate-card boundaries", () => {
  it("rejects an incomplete card rather than treating an omitted resource as free", async () => {
    const response = await POST(request({
      action: "create", name: "GPU family", serviceId: "service-1", pricePerHourCents: 250,
      configurationPricing: { cpuCoreHourCents: 1, ramGbHourCents: 0 },
    }));
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateHAIService).not.toHaveBeenCalled();
  });

  it("rejects a negative resource rate on updates", async () => {
    const response = await POST(request({
      action: "update", id: existing.id,
      configurationPricing: { ...rates, rootGbHourCents: -0.01 },
    }));
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([rates, null])("accepts an unlocked hourly GPU VM with resource rates %j", async (configurationPricing) => {
    mocks.hostedaiRequest.mockResolvedValue({
      ...unlockedService, service_type: "cpu_gpu_card", instance_config: { auto_assign_network: "both" },
    });
    const response = await POST(request({
      action: "create", name: "GPU family", serviceId: "service-1", pricePerHourCents: 0,
      configurationPricing,
    }));
    expect(response.status).toBe(200);
  });

  it("rejects moving a retained rate card to monthly billing", async () => {
    const response = await POST(request({
      action: "update", id: existing.id, billingType: "monthly", pricePerMonthCents: 10000,
    }));
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("allows removing an hourly rate card without changing provider resource locks", async () => {
    const response = await POST(request({
      action: "update", id: existing.id, serviceId: existing.serviceId, configurationPricing: null,
    }));
    expect(response.status).toBe(200);
    expect(mocks.hostedaiRequest).toHaveBeenCalled();
    expect(mocks.updateHAIService).not.toHaveBeenCalled();
  });

  it("keeps monthly products subject to default locks even on a price-only update", async () => {
    mocks.findUnique.mockResolvedValue({
      ...existing, billingType: "monthly", pricePerMonthCents: 10000, configurationPricing: null,
    });
    const response = await POST(request({ action: "update", id: existing.id, pricePerMonthCents: 12000 }));
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([rates, null])("accepts an unlocked hourly pod with resource rates %j", async (configurationPricing) => {
    const response = await POST(request({
      action: "create", name: "GPU family", serviceId: "service-1", pricePerHourCents: 250,
      configurationPricing, poolIds: [],
    }));
    expect(response.status).toBe(200);
    expect(mocks.updateHAIService).not.toHaveBeenCalled();
  });

  it("allows a bundled hourly price change without imposing resource locks", async () => {
    mocks.findUnique.mockResolvedValue({ ...existing, configurationPricing: null });
    const response = await POST(request({ action: "update", id: existing.id, pricePerHourCents: 300 }));
    expect(response.status).toBe(200);
    expect(mocks.updateHAIService).not.toHaveBeenCalled();
  });

  it("revalidates the service when removing hourly resource rates", async () => {
    mocks.hostedaiRequest.mockResolvedValue({ ...unlockedService, is_enabled: false });
    const response = await POST(request({
      action: "update", id: existing.id, configurationPricing: null,
    }));
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("accepts monthly pods only with locked included defaults and no additive rates", async () => {
    mocks.hostedaiRequest.mockResolvedValue({
      ...unlockedService,
      instance_config: {
        ...unlockedService.instance_config,
        instance_type_locked: true, storage_block_locked: true, image_locked: true,
      },
    });
    const response = await POST(request({
      action: "create", name: "Monthly GPU", serviceId: "service-1", billingType: "monthly",
      pricePerHourCents: 0, pricePerMonthCents: 10000, configurationPricing: null,
    }));
    expect(response.status).toBe(200);
    expect(mocks.updateHAIService).not.toHaveBeenCalled();
  });

  it("rejects monthly services without included defaults even when locks are set", async () => {
    mocks.hostedaiRequest.mockResolvedValue({
      ...unlockedService,
      instance_config: { instance_type_locked: true, storage_block_locked: true, image_locked: true },
    });
    const response = await POST(request({
      action: "create", name: "Monthly GPU", serviceId: "service-1", billingType: "monthly",
      pricePerHourCents: 0, pricePerMonthCents: 10000,
    }));
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("retains one-service-per-product uniqueness for bundled hourly offerings", async () => {
    mocks.findFirst.mockResolvedValue({ id: "other-product", name: "Other GPU" });
    const response = await POST(request({
      action: "create", name: "GPU family", serviceId: "service-1", pricePerHourCents: 250,
      configurationPricing: null,
    }));
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateHAIService).not.toHaveBeenCalled();
  });

  it("does not mutate upstream hardware when saving rates with unchanged pool assignments", async () => {
    const response = await POST(request({
      action: "update", id: existing.id, pricePerHourCents: 300,
      poolIds: [1], categoryIds: [], configurationPricing: rates,
    }));
    expect(response.status).toBe(200);
    expect(mocks.updateHAIService).not.toHaveBeenCalled();
  });

  it("allows deactivation with unchanged form values during a provider outage", async () => {
    mocks.hostedaiRequest.mockRejectedValue(new Error("Provider unavailable"));
    mocks.update.mockResolvedValue({ ...existing, active: false });
    const response = await POST(request({
      action: "update", id: existing.id, active: false, serviceId: existing.serviceId,
      billingType: existing.billingType, pricePerHourCents: existing.pricePerHourCents,
      pricePerMonthCents: null, stripeProductId: null, stripePriceId: null,
      configurationPricing: rates, poolIds: [1], categoryIds: [],
    }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.active).toBe(false);
    expect(mocks.hostedaiRequest).not.toHaveBeenCalled();
    expect(mocks.updateHAIService).not.toHaveBeenCalled();
  });

  it("still rejects malformed rate cards while deactivating during an outage", async () => {
    mocks.hostedaiRequest.mockRejectedValue(new Error("Provider unavailable"));
    const response = await POST(request({
      action: "update", id: existing.id, active: false,
      configurationPricing: { cpuCoreHourCents: 0, ramGbHourCents: 0 },
    }));
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("requires live service validation when reactivating an offering", async () => {
    mocks.findUnique.mockResolvedValue({ ...existing, active: false });
    mocks.hostedaiRequest.mockRejectedValue(new Error("Provider unavailable"));
    const response = await POST(request({ action: "update", id: existing.id, active: true }));
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([rates, null])("rejects ambiguous pod defaults with resource rates %j", async (configurationPricing) => {
    mocks.hostedaiRequest.mockResolvedValue({
      ...unlockedService, gpu_config: { default_gpu_pools: [1, 2] },
    });
    const response = await POST(request({
      action: "create", name: "GPU family", serviceId: "service-1", pricePerHourCents: 250,
      configurationPricing,
    }));
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateHAIService).not.toHaveBeenCalled();
  });

  it.each([rates, null])("allows explicit SKU pools with resource rates %j", async (configurationPricing) => {
    mocks.hostedaiRequest.mockResolvedValue({
      ...unlockedService, gpu_config: { default_gpu_pools: [1, 2] },
    });
    const response = await POST(request({
      action: "create", name: "GPU family", serviceId: "service-1", pricePerHourCents: 250,
      configurationPricing, poolIds: [1],
    }));
    expect(response.status).toBe(200);
    expect(mocks.updateHAIService).toHaveBeenCalledWith("service-1", {
      gpu_config: { default_gpu_pools: [1] },
    });
  });

  it.each([rates, null])("preserves the provider default when clearing hourly pools with resource rates %j", async (configurationPricing) => {
    mocks.findUnique.mockResolvedValue({ ...existing, configurationPricing });
    const response = await POST(request({
      action: "update", id: existing.id, poolIds: [],
    }));
    expect(response.status).toBe(200);
    expect(mocks.updateHAIService).not.toHaveBeenCalled();
  });

  it("syncs an explicit hourly pool change without rewriting provider resource policy", async () => {
    mocks.findUnique.mockResolvedValue({ ...existing, configurationPricing: null });
    const response = await POST(request({
      action: "update", id: existing.id, poolIds: [2],
    }));
    expect(response.status).toBe(200);
    expect(mocks.updateHAIService).toHaveBeenCalledWith("service-1", {
      gpu_config: { default_gpu_pools: [2] },
    });
  });

  it.each([rates, null])("rejects a missing GPU VM model with resource rates %j", async (configurationPricing) => {
    mocks.hostedaiRequest.mockResolvedValue({
      ...unlockedService, service_type: "cpu_gpu_card", gpu_config: { default_gpu_model_id: null },
    });
    const response = await POST(request({
      action: "create", name: "GPU family", serviceId: "service-1", pricePerHourCents: 250,
      configurationPricing,
    }));
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([rates, null])("rejects manual GPU VM networks with resource rates %j", async (configurationPricing) => {
    mocks.hostedaiRequest.mockResolvedValue({
      ...unlockedService, service_type: "cpu_gpu_card",
      instance_config: { ...unlockedService.instance_config, auto_assign_network: "public" },
    });
    const response = await POST(request({
      action: "create", name: "GPU family", serviceId: "service-1", pricePerHourCents: 250,
      configurationPricing,
    }));
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.updateHAIService).not.toHaveBeenCalled();
  });
});

describe("Hourly service picker", () => {
  it("includes unlocked GPU pods and VMs but excludes disabled and non-GPU services", async () => {
    mocks.hostedaiRequest.mockResolvedValue({ items: [
      unlockedService,
      { ...unlockedService, id: "vm", service_type: "cpu_gpu_card" },
      { ...unlockedService, id: "disabled", is_enabled: false },
      { ...unlockedService, id: "cpu", service_type: "cpu" },
    ] });
    const response = await listServices(new NextRequest(
      "http://localhost/api/admin/hai-services?offering_mode=configurable",
      { headers: { cookie: "admin_session=valid" } },
    ));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.services.map((service: { id: string }) => service.id)).toEqual(["service-1", "vm"]);
  });
});
