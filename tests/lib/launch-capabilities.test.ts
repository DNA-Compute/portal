import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedCustomer } from "@/lib/auth/helpers";
import type { LaunchConfiguration } from "@/lib/launch-config";
import { getLaunchCapabilities, resolveLaunchConfiguration } from "@/lib/launch-capabilities";

const mocks = vi.hoisted(() => ({
  product: vi.fn(), context: vi.fn(), scenarios: vi.fn(), services: vi.fn(), regions: vi.fn(), teamRegions: vi.fn(),
  info: vi.fn(), pools: vi.fn(), models: vi.fn(), resources: vi.fn(), blocks: vi.fn(), volumes: vi.fn(),
  wholeGpuCapacity: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { gpuProduct: { findFirst: mocks.product } } }));
vi.mock("@/lib/auth/account-resolver", () => ({ resolveOperatingContext: mocks.context }));
vi.mock("@/lib/hostedai", () => ({
  getTeamAccessibleScenarios: mocks.scenarios, getScenarioCompatibleServices: mocks.services,
  getServiceCompatibleRegions: mocks.regions, getTeamAccessibleLaunchRegions: mocks.teamRegions,
  getServiceProvisioningInfo: mocks.info, getServiceCompatibleGPUPools: mocks.pools,
  getServiceCompatibleGpuModels: mocks.models, getLaunchServiceResources: mocks.resources,
  getServicePoolMaxVgpus: mocks.wholeGpuCapacity,
  getSharedStorageBlocks: mocks.blocks, getSharedVolumes: mocks.volumes,
}));

const product = { id: "offering", name: "GPU", active: true, serviceId: "service", billingType: "hourly", pricePerHourCents: 100,
  poolIds: "[7]", vramGb: 80,
  configurationPricing: { cpuCoreHourCents: 1, ramGbHourCents: 0.25, rootGbHourCents: 0.1 } };
function auth(): AuthenticatedCustomer {
  return { accountId: "account", teamId: "team", allTeamIds: ["team", "other-team"], can: () => true,
    customer: { id: "account", metadata: { hostedai_team_id: "team", billing_type: "hourly" } },
    payload: { email: "owner@example.test", customerId: "account" },
  } as unknown as AuthenticatedCustomer;
}
function info() {
  return { service_type: "pod_accelerator",
    instance_type_details: { is_locked: false, gpu_scaling: true, default: { id: "profile" } },
    image_details: { is_locked: false, default: { hash: "image" } },
    storage_block_details: { is_locked: false, gpu_scaling: true, default: { id: "root" } },
    gpu_pool_details: { is_locked: false, is_quantity_locked: false, quantity: 1, max_quantity: 8, default: [{ id: 7 }] } };
}
const configuration: LaunchConfiguration = { productId: "offering", regionId: 2, poolId: 7, gpuCount: 2,
  instanceTypeId: "profile", imageHash: "image", rootStorageBlockId: "root", storage: { mode: "none" }, software: { kind: "none" } };
const ownedVolume = { id: 50, name: "Owned", team_id: "team", region_id: 2, size_in_gb: 200, status: "AVAILABLE" };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.product.mockResolvedValue(product);
  mocks.scenarios.mockResolvedValue([{ id: "scenario" }]);
  mocks.services.mockResolvedValue([{ id: "service", service_type: "pod_accelerator" }]);
  mocks.regions.mockResolvedValue([{ id: 2, region_name: "West" }]);
  mocks.teamRegions.mockResolvedValue([{ id: 2, region_name: "West" }]);
  mocks.info.mockResolvedValue(info());
  mocks.pools.mockResolvedValue([{ id: 7, pool_name: "GPU pool", scheduler_mode: "disabled", sharing_ratio: 1, available_vgpus: 4 }]);
  mocks.resources.mockImplementation(async (kind: string) => {
    if (kind === "compatible-images") return { Ubuntu: [{ hash: "image" }] };
    if (kind === "instance-types") return [{ id: "profile", name: "4 CPU", vcpus: 4, memory_mb: 8192 }];
    if (kind === "storage-blocks") return [{ id: "root", name: "Root", size_in_gb: 40, is_available: true }];
    if (kind === "shared-volumes") return [{ id: 50 }];
    throw new Error("Unexpected native resource request");
  });
  mocks.blocks.mockResolvedValue([{ id: "shared", name: "Shared", size: 200 }]);
  mocks.volumes.mockResolvedValue([ownedVolume]);
});

function offerResourceAlternatives() {
  const originalResources = mocks.resources.getMockImplementation()!;
  mocks.resources.mockImplementation(async (kind: string, ...args: unknown[]) => {
    if (kind === "compatible-images") return { Ubuntu: [{ hash: "image" }], Debian: [{ hash: "other-image" }] };
    if (kind === "instance-types") return [
      { id: "profile", name: "Included", vcpus: 4, memory_mb: 8192 },
      { id: "other-profile", name: "Larger", vcpus: 8, memory_mb: 16384 },
    ];
    if (kind === "storage-blocks") return [
      { id: "root", name: "Included", size_in_gb: 40 },
      { id: "other-root", name: "Larger", size_in_gb: 100 },
    ];
    return originalResources(kind, ...args);
  });
}

describe("launch capabilities trust boundary", () => {
  it("returns compatible regions without fetching resources in every region", async () => {
    const capabilities = await getLaunchCapabilities(auth(), "offering");
    expect(capabilities.regions).toEqual([{ id: 2, name: "West" }]);
    expect(capabilities.profiles).toEqual([]);
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.resources).not.toHaveBeenCalled();
  });

  it("normalizes native MiB dimensions and applies provider GPU scaling exactly once", async () => {
    const resolved = await resolveLaunchConfiguration(auth(), configuration);
    expect(resolved.profile).toMatchObject({ cpuCores: 8, ramGb: 16 });
    expect(resolved.rootStorage.sizeGb).toBe(80);
    expect(resolved.image.id).toBe("image");
  });

  it("discovers selectable resources without a rate card but does not price upgrades as the included bundle", async () => {
    mocks.product.mockResolvedValue({ ...product, configurationPricing: null });
    const originalResources = mocks.resources.getMockImplementation()!;
    mocks.resources.mockImplementation(async (kind: string, ...args: unknown[]) => {
      if (kind === "instance-types") return [
        { id: "profile", name: "Default", vcpus: 4, memory_mb: 8192 },
        { id: "upgraded-profile", name: "Selected", vcpus: 32, memory_mb: 65536 },
      ];
      if (kind === "storage-blocks") return [
        { id: "root", name: "Default", size_in_gb: 40 },
        { id: "upgraded-root", name: "Selected", size_in_gb: 750 },
      ];
      return originalResources(kind, ...args);
    });
    const capabilities = await getLaunchCapabilities(auth(), "offering", 2, 7, undefined, {
      gpuCount: 1, imageHash: "image", instanceTypeId: "upgraded-profile",
    });
    expect(capabilities.profiles.find(item => item.id === "upgraded-profile")).toMatchObject({ cpuCores: 32, ramGb: 64 });
    expect(capabilities.rootStorageBlocks.find(item => item.id === "upgraded-root")?.sizeGb).toBe(750);
    expect(capabilities.locks.profile).toBe(false);
    expect(capabilities.locks.rootStorage).toBe(false);
    await expect(resolveLaunchConfiguration(auth(), { ...configuration, gpuCount: 1,
      instanceTypeId: "upgraded-profile", rootStorageBlockId: "upgraded-root",
    })).rejects.toMatchObject({ status: 422, code: "RESOURCE_PRICING_UNAVAILABLE" });
    const included = await resolveLaunchConfiguration(auth(), { ...configuration, gpuCount: 1 });
    expect(included.profile.cpuCores).toBe(4);
    expect(included.rootStorage.sizeGb).toBe(40);
  });

  it("treats a zero service maximum as uncapped while retaining the actual whole-GPU pool limit", async () => {
    mocks.info.mockResolvedValue({ ...info(), gpu_pool_details: { ...info().gpu_pool_details, max_quantity: 0 } });
    const capabilities = await getLaunchCapabilities(auth(), "offering", 2, 7);
    expect(capabilities.maxGpuCount).toBe(4);
    expect(capabilities.profiles[0]).toMatchObject({ cpuCores: 4, ramGb: 8 });
    await expect(resolveLaunchConfiguration(auth(), { ...configuration, gpuCount: 5 })).rejects.toMatchObject({ code: "GPU_UNAVAILABLE" });
    mocks.pools.mockResolvedValue([{ id: 7, pool_name: "Full", scheduler_mode: "disabled", sharing_ratio: 1, available_vgpus: 0 }]);
    await expect(resolveLaunchConfiguration(auth(), configuration)).rejects.toMatchObject({ code: "NO_CAPACITY" });
  });

  it("uses scoped image discovery when a customizable service omits image policy metadata", async () => {
    mocks.info.mockResolvedValue({ ...info(), image_details: null });
    const resolved = await resolveLaunchConfiguration(auth(), configuration);
    expect(resolved.image.id).toBe("image");
    await expect(resolveLaunchConfiguration(auth(), { ...configuration, imageHash: "unavailable-image" })).rejects.toMatchObject({ status: 409 });
  });

  it("rejects explicit malformed image policy and locked images without a default", async () => {
    for (const imageDetails of [{ is_locked: "false" }, { is_locked: true }]) {
      mocks.info.mockResolvedValue({ ...info(), image_details: imageDetails });
      await expect(resolveLaunchConfiguration(auth(), configuration)).rejects.toMatchObject({ status: 502, code: "PROVIDER_METADATA" });
    }
  });

  it("caps an uncapped pod service at the supported request quantity", async () => {
    mocks.info.mockResolvedValue({ ...info(), gpu_pool_details: { ...info().gpu_pool_details, max_quantity: 0 } });
    mocks.pools.mockResolvedValue([{ id: 7, pool_name: "Large pool", scheduler_mode: "disabled", sharing_ratio: 1, available_vgpus: 1024 }]);
    const capabilities = await getLaunchCapabilities(auth(), "offering", 2, 7);
    expect(capabilities.maxGpuCount).toBe(256);
    await expect(getLaunchCapabilities(auth(), "offering", 2, 7, undefined, { gpuCount: 257 })).rejects.toMatchObject({ code: "GPU_UNAVAILABLE" });
  });

  it("rejects missing service capacity rather than assuming an uncapped service", async () => {
    mocks.info.mockResolvedValue({ ...info(), gpu_pool_details: { ...info().gpu_pool_details, max_quantity: undefined } });
    await expect(resolveLaunchConfiguration(auth(), configuration)).rejects.toMatchObject({ code: "PROVIDER_METADATA" });
  });

  it("does not infer GPU VM capacity from a zero maximum", async () => {
    mocks.services.mockResolvedValue([{ id: "service", service_type: "cpu_gpu_card" }]);
    mocks.info.mockResolvedValue({ ...info(), service_type: "cpu_gpu_card", auto_assign_network: "both",
      accelerator_info: { default: { model_id: "h100", is_locked: false }, quantity: 1, max_quantity: 0, is_quantity_locked: false } });
    mocks.models.mockResolvedValue([{ model_id: "h100", model_name: "H100" }]);
    await expect(resolveLaunchConfiguration(auth(), { ...configuration, poolId: undefined, gpuModelId: "h100" })).rejects.toMatchObject({ code: "NO_CAPACITY" });
  });

  it.each([
    { source: "marketplace", capable: false, enabled: false },
    { source: "marketplace", capable: true, enabled: true },
    { source: "marketplace", capable: undefined, enabled: true },
    { source: "owned", capable: false, enabled: true },
  ])("resolves root persistence for $source pools advertising $capable", async ({ source, capable, enabled }) => {
    mocks.pools.mockResolvedValue([{ id: 7, pool_name: "GPU pool", scheduler_mode: "disabled", sharing_ratio: 1,
      available_vgpus: 4, pool_source: source, rootfs_persistence_capable: capable }]);
    const resolved = await resolveLaunchConfiguration(auth(), configuration);
    expect(resolved.podOptions?.rootfsEnabled).toBe(enabled);
  });

  it("does not advertise or resolve shared volumes for a marketplace pool that cannot attach them", async () => {
    mocks.pools.mockResolvedValue([{ id: 7, pool_name: "Marketplace", scheduler_mode: "disabled", sharing_ratio: 1,
      available_vgpus: 4, pool_source: "marketplace", shared_storage_capable: false }]);
    const capabilities = await getLaunchCapabilities(auth(), "offering", 2, 7);
    expect(capabilities.sharedStorageBlocks).toEqual([]);
    expect(capabilities.volumes).toEqual([]);
    for (const storage of [{ mode: "new" as const, blockId: "shared" }, { mode: "existing" as const, volumeId: 50 }]) {
      await expect(resolveLaunchConfiguration(auth(), { ...configuration, storage })).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
    }
  });

  it("still offers a launch without shared storage when the provider cannot report it", async () => {
    mocks.blocks.mockRejectedValue(new Error("Failed to get storage node availability"));
    const capabilities = await getLaunchCapabilities(auth(), "offering", 2, 7);
    expect(capabilities.sharedStorageUnavailable).toBe(true);
    expect(capabilities.rootStorageBlocks.map(block => block.id)).toEqual(["root"]);
    expect(capabilities.sharedStorageBlocks).toEqual([]);
    expect(capabilities.volumes).toEqual([]);
    await expect(resolveLaunchConfiguration(auth(), configuration)).resolves.toMatchObject({ sharedStorage: null });
    await expect(resolveLaunchConfiguration(auth(), { ...configuration, storage: { mode: "existing", volumeId: 50 } })).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
  });

  it("normalizes ram_mb and cpu_cores profiles with provider GPU scaling", async () => {
    const originalResources = mocks.resources.getMockImplementation()!;
    mocks.resources.mockImplementation(async (kind: string, ...args: unknown[]) => kind === "instance-types"
      ? [{ id: "profile", name: "Memory optimized", cpu_cores: 2, ram_mb: 65536 }]
      : originalResources(kind, ...args));

    const resolved = await resolveLaunchConfiguration(auth(), configuration);
    expect(resolved.profile).toMatchObject({ cpuCores: 4, ramGb: 128 });
  });

  it("rejects ram_mb that conflicts with another RAM dimension", async () => {
    const originalResources = mocks.resources.getMockImplementation()!;
    mocks.resources.mockImplementation(async (kind: string, ...args: unknown[]) => kind === "instance-types"
      ? [{ id: "profile", name: "Conflicting RAM", vcpus: 4, memory_mb: 8192, ram_mb: 16384 }]
      : originalResources(kind, ...args));

    await expect(resolveLaunchConfiguration(auth(), configuration)).rejects.toMatchObject({ code: "PROVIDER_METADATA" });
  });

  it("rejects ambiguous or missing resource units instead of guessing", async () => {
    mocks.resources.mockImplementation(async (kind: string) => kind === "compatible-images"
      ? { Ubuntu: [{ hash: "image" }] }
      : [{ id: "profile", name: "Ambiguous", vcpus: 4, memory_mb: 8192, ram_gb: 16 }]);
    await expect(resolveLaunchConfiguration(auth(), configuration)).rejects.toMatchObject({ code: "PROVIDER_METADATA" });
  });

  it("rejects an active product whose service is not permitted for this team", async () => {
    mocks.services.mockResolvedValue([{ id: "other-service", service_type: "pod_accelerator" }]);
    await expect(resolveLaunchConfiguration(auth(), configuration)).rejects.toMatchObject({ status: 403, code: "SERVICE_NOT_PERMITTED" });
  });

  it("rejects a service region outside the operating team's permitted regions", async () => {
    mocks.teamRegions.mockResolvedValue([{ id: 3 }]);
    await expect(resolveLaunchConfiguration(auth(), configuration)).rejects.toMatchObject({ code: "REGION_UNAVAILABLE" });
  });

  it("does not accept a profile that the selected image's scoped endpoint excludes", async () => {
    await expect(resolveLaunchConfiguration(auth(), { ...configuration, instanceTypeId: "other-region-profile" })).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a GPU quantity above real pool capacity even when the service allows more", async () => {
    await expect(resolveLaunchConfiguration(auth(), { ...configuration, gpuCount: 5 })).rejects.toMatchObject({ code: "GPU_UNAVAILABLE" });
  });

  it("rejects a cheaper SKU used to select another service-compatible GPU pool", async () => {
    mocks.pools.mockResolvedValue([
      { id: 7, pool_name: "Offered GPU", scheduler_mode: "disabled", sharing_ratio: 1, available_vgpus: 4 },
      { id: 8, pool_name: "More expensive GPU", scheduler_mode: "disabled", sharing_ratio: 1, available_vgpus: 8 },
    ]);
    const capabilities = await getLaunchCapabilities(auth(), "offering", 2);
    expect(capabilities.pools.map(pool => pool.id)).toEqual([7]);
    await expect(resolveLaunchConfiguration(auth(), { ...configuration, poolId: 8 })).rejects.toMatchObject({ code: "GPU_UNAVAILABLE" });
  });

  it("retains explicit offering pools across regions instead of imposing a different region's default", async () => {
    mocks.product.mockResolvedValue({ ...product, poolIds: "[7,8]" });
    mocks.pools.mockResolvedValue([{ id: 8, pool_name: "Same GPU in this region", scheduler_mode: "disabled", sharing_ratio: 1, available_vgpus: 4 }]);
    const capabilities = await getLaunchCapabilities(auth(), "offering", 2);
    expect(capabilities.pools.map(pool => pool.id)).toEqual([8]);
    const resolved = await resolveLaunchConfiguration(auth(), { ...configuration, poolId: 8 });
    expect(resolved.gpuVramGb).toBe(80);
  });

  it("uses a single provider default when no catalog pool mapping exists and rejects ambiguity", async () => {
    mocks.product.mockResolvedValue({ ...product, poolIds: "[]" });
    const resolved = await resolveLaunchConfiguration(auth(), configuration);
    expect(resolved.gpuVramGb).toBe(80);
    mocks.info.mockResolvedValue({ ...info(), gpu_pool_details: { ...info().gpu_pool_details, default: [{ id: 7 }, { id: 8 }] } });
    await expect(resolveLaunchConfiguration(auth(), configuration)).rejects.toMatchObject({ code: "PROVIDER_METADATA" });
  });

  it("uses catalog memory only for bound hardware and respects a smaller provider limit", async () => {
    expect((await resolveLaunchConfiguration(auth(), configuration)).gpuVramGb).toBe(80);
    mocks.pools.mockResolvedValue([{ id: 7, pool_name: "Bound GPU", scheduler_mode: "disabled", sharing_ratio: 1, available_vgpus: 4, vram_gb: 40 }]);
    expect((await resolveLaunchConfiguration(auth(), configuration)).gpuVramGb).toBe(40);
  });

  it("rejects GPU VM services requiring manual network selection before quoting", async () => {
    mocks.services.mockResolvedValue([{ id: "service", service_type: "cpu_gpu_card" }]);
    mocks.info.mockResolvedValue({ ...info(), service_type: "cpu_gpu_card", auto_assign_network: "none" });
    await expect(resolveLaunchConfiguration(auth(), { ...configuration, poolId: undefined, gpuModelId: "h100" })).rejects.toMatchObject({ code: "UNSUPPORTED_NETWORK_CONFIGURATION" });
  });

  it("binds GPU VM rates to the service default model, not every compatible accelerator", async () => {
    mocks.services.mockResolvedValue([{ id: "service", service_type: "cpu_gpu_card" }]);
    mocks.info.mockResolvedValue({ ...info(), service_type: "cpu_gpu_card", auto_assign_network: "both",
      accelerator_info: { default: { model_id: "h100", is_locked: false }, quantity: 1, max_quantity: 4, is_quantity_locked: false } });
    mocks.models.mockResolvedValue([{ model_id: "h100", model_name: "H100" }, { model_id: "h200", model_name: "H200" }]);
    const capabilities = await getLaunchCapabilities(auth(), "offering", 2);
    expect(capabilities.gpuModels.map(model => model.id)).toEqual(["h100"]);
    await expect(resolveLaunchConfiguration(auth(), { ...configuration, poolId: undefined, gpuModelId: "h200" })).rejects.toMatchObject({ code: "GPU_UNAVAILABLE" });
  });

  it("does not advertise fractional pools through whole-GPU pricing", async () => {
    mocks.pools.mockResolvedValue([{ id: 7, pool_name: "Shared", scheduler_mode: "user_selected", sharing_ratio: 4, available_vgpus: 32,
      scheduler_mode_settings: { locked_to_minimum_guarantee: true, default_minimum_guarantee: 25 } }]);
    await expect(resolveLaunchConfiguration(auth(), configuration)).rejects.toMatchObject({ code: "GPU_UNAVAILABLE" });
  });

  it("reserves every time slice and bounds quantities by whole-GPU capacity", async () => {
    mocks.pools.mockResolvedValue([{ id: 7, pool_name: "Full share", scheduler_mode: "user_selected", sharing_ratio: 4,
      available_vgpus: 32, available_tq_percentages: [25, 50, 75, 100],
      scheduler_mode_settings: { locked_to_minimum_guarantee: false } }]);
    mocks.wholeGpuCapacity.mockResolvedValue(2);
    const resolved = await resolveLaunchConfiguration(auth(), configuration);
    expect(resolved.podOptions).toMatchObject({ guaranteedGpuSharePercent: 100 });
    await expect(resolveLaunchConfiguration(auth(), { ...configuration, gpuCount: 3 })).rejects.toMatchObject({ code: "GPU_UNAVAILABLE" });
  });

  it("discovers unpriced quantity changes but resolves only the included quantity", async () => {
    mocks.product.mockResolvedValue({ ...product, configurationPricing: null });
    const capabilities = await getLaunchCapabilities(auth(), "offering", 2, 7, undefined, { gpuCount: 2 });
    expect(capabilities.profiles[0]).toMatchObject({ cpuCores: 8, ramGb: 16 });
    expect(capabilities.maxGpuCount).toBe(4);
    await expect(resolveLaunchConfiguration(auth(), configuration)).rejects.toMatchObject({ status: 422, code: "RESOURCE_PRICING_UNAVAILABLE" });
    const resolved = await resolveLaunchConfiguration(auth(), { ...configuration, gpuCount: 1 });
    expect(resolved.profile.cpuCores).toBe(4);
  });

  it.each([
    { imageHash: "other-image" },
    { instanceTypeId: "other-profile" },
    { rootStorageBlockId: "other-root" },
  ])("does not turn a selected resource into proof of included pricing: %j", async change => {
    mocks.product.mockResolvedValue({ ...product, configurationPricing: null });
    offerResourceAlternatives();
    await expect(resolveLaunchConfiguration(auth(), { ...configuration, gpuCount: 1, ...change }))
      .rejects.toMatchObject({ status: 422, code: "RESOURCE_PRICING_UNAVAILABLE" });
  });

  it.each(["profile", "image", "root", "quantity"])("does not infer an included allocation from a missing %s default", async missing => {
    mocks.product.mockResolvedValue({ ...product, configurationPricing: null });
    const defaults = info();
    mocks.info.mockResolvedValue({
      ...defaults,
      ...(missing === "profile" ? { instance_type_details: { ...defaults.instance_type_details, default: null } } : {}),
      ...(missing === "image" ? { image_details: null } : {}),
      ...(missing === "root" ? { storage_block_details: { ...defaults.storage_block_details, default: null } } : {}),
      ...(missing === "quantity" ? { gpu_pool_details: { ...defaults.gpu_pool_details, quantity: undefined } } : {}),
    });
    await expect(resolveLaunchConfiguration(auth(), { ...configuration, gpuCount: 1 }))
      .rejects.toMatchObject({ status: 422, code: "RESOURCE_PRICING_UNAVAILABLE" });
  });

  it("checks resource compatibility before rejecting an unpriced allocation", async () => {
    mocks.product.mockResolvedValue({ ...product, configurationPricing: null });
    await expect(resolveLaunchConfiguration(auth(), { ...configuration, gpuCount: 1, rootStorageBlockId: "not-compatible" }))
      .rejects.toMatchObject({ status: 409, code: "RESOURCE_UNAVAILABLE" });
  });

  it.each(["provider", "monthly"])("enforces %s allocation locks even with resource rates and compatible alternatives", async policy => {
    const customer = auth();
    const monthly = policy === "monthly";
    mocks.product.mockResolvedValue({ ...product, poolIds: "[7,8]", billingType: monthly ? "monthly" : "hourly", stripePriceId: "monthly-price" });
    if (monthly) {
      mocks.context.mockResolvedValue({ accountId: "account", monthlyCustomerIds: [] });
      customer.stripe = { subscriptions: { list: async function* () {
        yield { items: { data: [{ price: { id: "monthly-price" } }] } };
      } } } as unknown as AuthenticatedCustomer["stripe"];
    } else {
      const defaults = info();
      mocks.info.mockResolvedValue({
        ...defaults,
        instance_type_details: { ...defaults.instance_type_details, is_locked: true },
        image_details: { ...defaults.image_details, is_locked: true },
        storage_block_details: { ...defaults.storage_block_details, is_locked: true },
        gpu_pool_details: { ...defaults.gpu_pool_details, is_locked: true, is_quantity_locked: true },
      });
    }
    offerResourceAlternatives();
    mocks.pools.mockResolvedValue([
      { id: 7, pool_name: "Included", scheduler_mode: "disabled", sharing_ratio: 1, available_vgpus: 4 },
      { id: 8, pool_name: "Alternative", scheduler_mode: "disabled", sharing_ratio: 1, available_vgpus: 4 },
    ]);
    const capabilities = await getLaunchCapabilities(customer, "offering", 2, 7);
    expect(capabilities.profiles.map(item => item.id)).toEqual(["profile"]);
    expect(capabilities.images.map(item => item.id)).toEqual(["image"]);
    expect(capabilities.rootStorageBlocks.map(item => item.id)).toEqual(["root"]);
    expect(capabilities.pools.map(item => item.id)).toEqual([7]);
    const included = { ...configuration, gpuCount: 1 };
    const resolved = await resolveLaunchConfiguration(customer, included);
    expect(resolved.profile).toMatchObject({ cpuCores: 4, ramGb: 8 });
    expect(resolved.rootStorage.sizeGb).toBe(40);
    if (monthly) expect(resolved.configurationPricing).toBeNull();
    for (const change of [
      { gpuCount: 2 }, { poolId: 8 }, { imageHash: "other-image" },
      { instanceTypeId: "other-profile" }, { rootStorageBlockId: "other-root" },
    ]) {
      await expect(resolveLaunchConfiguration(customer, { ...included, ...change })).rejects.toMatchObject({ status: 409 });
    }
  });

  it("rejects incomplete rate cards rather than treating absent rates as free", async () => {
    mocks.product.mockResolvedValue({ ...product, configurationPricing: { cpuCoreHourCents: 1 } });
    await expect(resolveLaunchConfiguration(auth(), configuration)).rejects.toMatchObject({ code: "PROVIDER_METADATA" });
  });

  it("intersects service-compatible volumes with team ownership, region, and ready status", async () => {
    const wrongTeam = { ...ownedVolume, id: 51, team_id: "other-team" };
    const wrongRegion = { ...ownedVolume, id: 52, region_id: 3 };
    const provisioning = { ...ownedVolume, id: 53, status: "CREATING" };
    const incompatible = { ...ownedVolume, id: 54 };
    mocks.volumes.mockResolvedValue([ownedVolume, wrongTeam, wrongRegion, provisioning, incompatible]);
    const originalResources = mocks.resources.getMockImplementation()!;
    mocks.resources.mockImplementation(async (kind: string, ...args: unknown[]) => kind === "shared-volumes"
      ? [{ id: 50 }, { id: 51 }, { id: 52 }, { id: 53 }] : originalResources(kind, ...args));
    const capabilities = await getLaunchCapabilities(auth(), "offering", 2, 7);
    expect(capabilities.volumes.map(volume => volume.id)).toEqual([50]);
    await expect(resolveLaunchConfiguration(auth(), { ...configuration, storage: { mode: "existing", volumeId: 51 } })).rejects.toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
  });

  it("requires storage permission for attachments even with GPU launch permission", async () => {
    const context = auth();
    context.can = permission => permission !== "storage.manage";
    await expect(resolveLaunchConfiguration(context, { ...configuration, storage: { mode: "existing", volumeId: 50 } })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("distinguishes provider outages from an empty capacity response", async () => {
    mocks.pools.mockRejectedValueOnce(new Error("Provider down"));
    await expect(resolveLaunchConfiguration(auth(), configuration)).rejects.toMatchObject({ status: 503, code: "PROVIDER_UNAVAILABLE" });
    mocks.pools.mockResolvedValue([{ id: 7, pool_name: "Full", scheduler_mode: "disabled", sharing_ratio: 1, available_vgpus: 0 }]);
    await expect(resolveLaunchConfiguration(auth(), configuration)).rejects.toMatchObject({ status: 409, code: "NO_CAPACITY" });
  });
});
