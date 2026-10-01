import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { LaunchConfiguration, LaunchQuote, ResolvedLaunchConfiguration } from "@/lib/launch-config";
import { getPodHourlyRateCents, getPodStoppedHourlyRateCents, type PodRateInput } from "@/lib/pod-billing";
import type { LaunchServiceQuery } from "@/lib/hostedai";
import type * as LaunchQuoteModule from "@/lib/launch-quote";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), permission: vi.fn(), quote: vi.fn(),
  operatingContext: vi.fn(),
  prepare: vi.fn(), complete: vi.fn(), create: vi.fn(), removeInstance: vi.fn(),
  createVolume: vi.fn(), removeVolume: vi.fn(), volumes: vi.fn(), workspaces: vi.fn(), detail: vi.fn(),
  wallet: vi.fn(), debit: vi.fn(), refund: vi.fn(), monitor: vi.fn(),
  product: vi.fn(), keys: vi.fn(), metadata: vi.fn(), pods: vi.fn(), update: vi.fn(), transaction: vi.fn(),
  retrieveCustomer: vi.fn(), updateCustomer: vi.fn(), listCustomers: vi.fn(), retrieveSubscription: vi.fn(), listSubscriptions: vi.fn(),
  catalogProduct: vi.fn(), validateSoftware: vi.fn(), storageRate: vi.fn(), stoppedRate: vi.fn(),
  scenarios: vi.fn(), services: vi.fn(), regions: vi.fn(), teamRegions: vi.fn(),
  provisioningInfo: vi.fn(), pools: vi.fn(), models: vi.fn(), resources: vi.fn(), blocks: vi.fn(), wholeGpuCapacity: vi.fn(),
}));
vi.mock("@/lib/auth/helpers", () => ({ getAuthenticatedCustomer: mocks.auth }));
vi.mock("@/lib/auth/audit", () => ({ requirePermission: mocks.permission }));
vi.mock("@/lib/auth/account-resolver", () => ({ resolveOperatingContext: mocks.operatingContext }));
vi.mock("@/lib/launch-quote", () => ({ resolveAndQuoteLaunch: mocks.quote }));
vi.mock("@/lib/launch-software", () => ({ prepareLaunchSoftware: mocks.prepare, completeLaunchSoftware: mocks.complete, validateLaunchSoftware: mocks.validateSoftware }));
vi.mock("@/lib/pricing", () => ({ getStoragePricePerGBHourCents: mocks.storageRate, getStoppedInstanceRatePercent: mocks.stoppedRate }));
vi.mock("@/lib/hostedai", () => ({
  createInstance: mocks.create, deleteInstance: mocks.removeInstance, createSharedVolume: mocks.createVolume,
  deleteSharedVolume: mocks.removeVolume, getSharedVolumes: mocks.volumes, getTeamWorkspaces: mocks.workspaces,
  getUnifiedInstanceDetail: mocks.detail, getTeamAccessibleScenarios: mocks.scenarios,
  getScenarioCompatibleServices: mocks.services, getServiceCompatibleRegions: mocks.regions,
  getTeamAccessibleLaunchRegions: mocks.teamRegions, getServiceProvisioningInfo: mocks.provisioningInfo,
  getServiceCompatibleGPUPools: mocks.pools, getServiceCompatibleGpuModels: mocks.models,
  getLaunchServiceResources: mocks.resources, getSharedStorageBlocks: mocks.blocks,
  getServicePoolMaxVgpus: mocks.wholeGpuCapacity,
}));
vi.mock("@/lib/prisma", () => ({ prisma: { gpuProduct: { findUnique: mocks.product, findFirst: mocks.catalogProduct }, sSHKey: { findMany: mocks.keys }, podMetadata: { create: mocks.metadata, findMany: mocks.pods, update: mocks.update }, walletTransaction: { create: mocks.transaction } } }));
vi.mock("@/lib/customer-cache", () => ({ cacheCustomer: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/wallet", () => ({ getWalletBalance: mocks.wallet, deductUsage: mocks.debit, refundDeployment: mocks.refund }));
vi.mock("@/lib/deploy-monitor", () => ({ monitorDeployStatus: mocks.monitor }));
vi.mock("@/lib/metrics-collector", () => ({ installMetricsCollector: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/startup-script-runner", () => ({ runStartupScript: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/startup-scripts", () => ({ WORKSPACE_SETUP_SCRIPT: "workspace" }));
vi.mock("@/lib/activity", () => ({ logGPULaunched: vi.fn(), getFirstGpuLaunch: vi.fn() }));
vi.mock("@/lib/email/onboarding-events", () => ({ sendOnboardingEvent: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendGpuLaunchedEmail: vi.fn() }));
vi.mock("@/lib/customer-auth", () => ({ generateCustomerToken: vi.fn() }));

import { launchInstance } from "@/lib/instance-launch";

let configuration: LaunchConfiguration;
let resolved: ResolvedLaunchConfiguration;
let quote: LaunchQuote;
let walletCents: number;

beforeEach(() => {
  vi.clearAllMocks();
  for (const mock of Object.values(mocks)) mock.mockReset();
  configuration = { productId: "gpu", regionId: 2, instanceTypeId: "cpu8", imageHash: "ubuntu", rootStorageBlockId: "root100", gpuCount: 2, poolId: 12, storage: { mode: "new", blockId: "shared100" }, software: { kind: "none" } };
  resolved = { configuration, serviceId: "service", serviceType: "pod_accelerator", productName: "GPU", billingType: "hourly", gpuBaseHourCents: 100, configurationPricing: { cpuCoreHourCents: 1, ramGbHourCents: 1, rootGbHourCents: 1 }, profile: { id: "cpu8", name: "8 CPU", cpuCores: 8, ramGb: 32 }, image: { id: "ubuntu", name: "Ubuntu" }, rootStorage: { id: "root100", name: "100 GB", sizeGb: 100 }, sharedStorage: { blockId: "shared100", name: "Shared", sizeGb: 100 }, gpuName: "GPU", gpuVramGb: 24 };
  resolved.podOptions = { rootfsEnabled: true };
  quote = { fingerprint: "a".repeat(64), configuration, resources: { gpuName: "GPU", gpuCount: 2, cpuCores: 8, ramGb: 32, rootStorageGb: 100, sharedStorageGb: 100, imageName: "Ubuntu" }, rate: { version: 1, currency: "USD", basis: "per_instance", instanceHourlyCents: 340, sharedStorageHourlyCents: 10, totalHourlyCents: 350, stoppedInstanceHourlyCents: 85, stoppedRatePercent: 25, minimumBillingMinutes: 30, prepayCents: 170, lines: [] }, warnings: [] };
  const customer = { id: "cus_operating", email: "owner@example.com", metadata: { hostedai_team_id: "team" } };
  mocks.auth.mockResolvedValue({ customer, teamId: "team", allTeamIds: ["team"], accountId: customer.id, payload: { email: "member@example.com", customerId: "cus_member" }, stripe: { customers: { retrieve: mocks.retrieveCustomer, update: mocks.updateCustomer, list: mocks.listCustomers }, subscriptions: { retrieve: mocks.retrieveSubscription, list: mocks.listSubscriptions } } });
  mocks.operatingContext.mockResolvedValue({ accountId: customer.id, monthlyCustomerIds: ["cus_linked_monthly"] });
  mocks.permission.mockReturnValue(null);
  mocks.retrieveCustomer.mockResolvedValue(customer);
  mocks.updateCustomer.mockResolvedValue(customer);
  mocks.listCustomers.mockReturnValue([]);
  mocks.listSubscriptions.mockReturnValue([]);
  mocks.quote.mockImplementation(async () => ({ resolved, quote }));
  mocks.prepare.mockResolvedValue({});
  mocks.complete.mockResolvedValue(undefined);
  mocks.workspaces.mockResolvedValue([{ id: "workspace", name: "Default" }]);
  mocks.createVolume.mockResolvedValue({ id: 42 });
  mocks.volumes.mockResolvedValue([{ id: 42, status: "available" }]);
  mocks.removeVolume.mockResolvedValue(undefined);
  mocks.removeInstance.mockResolvedValue(undefined);
  mocks.create.mockResolvedValue({ id: "instance" });
  mocks.keys.mockResolvedValue([]);
  mocks.metadata.mockResolvedValue({});
  mocks.update.mockResolvedValue({});
  mocks.pods.mockResolvedValue([]);
  mocks.transaction.mockResolvedValue({});
  mocks.monitor.mockResolvedValue({ ready: false });
  mocks.product.mockResolvedValue({ id: "gpu", active: true, serviceId: "service", stripePriceId: "price_gpu", billingType: "monthly" });
  walletCents = 1000;
  mocks.wallet.mockImplementation(async () => ({ availableBalance: walletCents }));
  mocks.debit.mockImplementation(async (_customer, hours, _description, hourlyRate) => { walletCents -= Math.round(hours * hourlyRate); return { success: true }; });
  mocks.refund.mockImplementation(async (_customer, amount) => { walletCents += amount; return { success: true }; });
});

function request(extra: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/instances", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer token" }, body: JSON.stringify({ name: "My configured GPU", configuration, quoteFingerprint: quote.fingerprint, sshKeyIds: [], ...extra }) });
}

async function selectedResourcePipeline(configurationPricing: ResolvedLaunchConfiguration["configurationPricing"]) {
  const { resolveAndQuoteLaunch } = await vi.importActual<typeof LaunchQuoteModule>("@/lib/launch-quote");
  const authenticated = await mocks.auth();
  const auth = {
    ...authenticated,
    can: () => true,
    customer: { ...authenticated.customer, metadata: { ...authenticated.customer.metadata, billing_type: "hourly" } },
  };
  mocks.auth.mockResolvedValue(auth);
  mocks.quote.mockImplementation(resolveAndQuoteLaunch);
  mocks.validateSoftware.mockResolvedValue(undefined);
  mocks.storageRate.mockReturnValue(0.1);
  mocks.stoppedRate.mockReturnValue(25);
  mocks.catalogProduct.mockResolvedValue({
    id: "gpu", name: "GPU", active: true, serviceId: "service", billingType: "hourly",
    pricePerHourCents: 100, poolIds: "[12]", vramGb: 24, configurationPricing,
  });
  mocks.scenarios.mockResolvedValue([{ id: "scenario" }]);
  mocks.services.mockResolvedValue([{ id: "service", service_type: "pod_accelerator" }]);
  mocks.regions.mockResolvedValue([{ id: 2, region_name: "West" }]);
  mocks.teamRegions.mockResolvedValue([{ id: 2, region_name: "West" }]);
  const providerInfo = {
    service_type: "pod_accelerator",
    instance_type_details: { is_locked: false, gpu_scaling: false, default: { id: "cpu8" } },
    image_details: { is_locked: false, default: { hash: "ubuntu" } },
    storage_block_details: { is_locked: false, gpu_scaling: false, default: { id: "root100" } },
    gpu_pool_details: { is_locked: false, is_quantity_locked: false, quantity: 1, max_quantity: 0, default: [{ id: 12 }] },
  };
  mocks.provisioningInfo.mockResolvedValue(providerInfo);
  mocks.pools.mockResolvedValue([{
    id: 12, pool_name: "GPU", scheduler_mode: "disabled", sharing_ratio: 1, available_vgpus: 4,
  }]);
  mocks.resources.mockImplementation(async (kind: string, query: LaunchServiceQuery) => {
    if (query.service_id !== "service" || query.team_id !== "team" || query.region_id !== 2
      || query.pool_id !== 12 || query.requested_gpu_count !== 1) return [];
    if (kind === "compatible-images") return { Ubuntu: [{ hash: "ubuntu" }] };
    if (query.image_hash !== "ubuntu") return [];
    if (kind === "instance-types") return [
      { id: "cpu8", name: "Default", vcpus: 8, memory_mb: 32768 },
      { id: "cpu16", name: "New default", vcpus: 16, memory_mb: 32768 },
      { id: "cpu32", name: "Selected", vcpus: 32, memory_mb: 65536 },
    ];
    if (query.instance_type !== "cpu32") return [];
    if (kind === "storage-blocks") return [
      { id: "root100", name: "Default root", size_in_gb: 100 },
      { id: "root250", name: "New default root", size_in_gb: 250 },
      { id: "root750", name: "Selected root", size_in_gb: 750 },
    ];
    if (kind === "shared-volumes") return [];
    throw new Error(`Unexpected native resource request: ${kind}`);
  });
  mocks.blocks.mockResolvedValue([{ id: "shared100", name: "Shared", size_in_gb: 100 }]);
  mocks.volumes.mockResolvedValue([{ id: 42, status: "available" }]);
  configuration = { ...configuration, gpuCount: 1, instanceTypeId: "cpu32", rootStorageBlockId: "root750" };
  return { auth, providerInfo, resolveAndQuoteLaunch };
}

describe("configured instance launch", () => {
  it("quotes and provisions selected resources at their own rates even when service defaults change", async () => {
    const { auth, providerInfo, resolveAndQuoteLaunch } = await selectedResourcePipeline({
      cpuCoreHourCents: 2, ramGbHourCents: 0.5, rootGbHourCents: 0.2,
    });
    mocks.provisioningInfo.mockResolvedValue({ ...providerInfo, image_details: null });
    ({ quote } = await resolveAndQuoteLaunch(auth, configuration));
    expect(quote.resources).toMatchObject({ gpuCount: 1, cpuCores: 32, ramGb: 64, rootStorageGb: 750, sharedStorageGb: 100 });
    expect(quote.rate).toMatchObject({
      instanceHourlyCents: 346, sharedStorageHourlyCents: 10, totalHourlyCents: 356, prepayCents: 173,
    });

    mocks.provisioningInfo.mockResolvedValue({
      ...providerInfo, image_details: null,
      instance_type_details: { ...providerInfo.instance_type_details, default: { id: "cpu16" } },
      storage_block_details: { ...providerInfo.storage_block_details, default: { id: "root250" } },
    });
    const response = await launchInstance(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, instance_id: "instance" });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      service_id: "service", instance_type_id: "cpu32", root_storage_type_id: "root750",
      image_hash: "ubuntu", region_id: 2,
      pod_opts: expect.objectContaining({ pool_id: 12, vgpus: 1, shared_volumes: [42] }),
    }));
    const persisted = mocks.metadata.mock.calls[0][0].data;
    expect(persisted.launchConfiguration).toMatchObject({
      serviceId: "service", instanceTypeId: "cpu32", rootStorageBlockId: "root750",
      resources: { gpuCount: 1, cpuCores: 32, ramGb: 64, rootStorageGb: 750 },
    });
    expect(getPodHourlyRateCents(persisted, 1)).toBe(346);
    expect(persisted.prepaidAmountCents).toBe(quote.rate.prepayCents);
    expect(mocks.debit).toHaveBeenCalledExactlyOnceWith("cus_operating", 0.5, expect.any(String), 346, expect.any(String));
    expect(walletCents).toBe(1000 - quote.rate.prepayCents);
    expect(mocks.transaction).toHaveBeenCalledWith({ data: expect.objectContaining({ amountCents: 173, hourlyRateCents: 346 }) });
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it("rejects supported resource upgrades without rates before payment or provisioning", async () => {
    const { auth, resolveAndQuoteLaunch } = await selectedResourcePipeline(null);
    await expect(resolveAndQuoteLaunch(auth, configuration)).rejects.toMatchObject({
      status: 422, code: "RESOURCE_PRICING_UNAVAILABLE",
    });
    const response = await launchInstance(request());
    expect(response.status).toBe(422);
    expect(walletCents).toBe(1000);
    expect(mocks.debit).not.toHaveBeenCalled();
    expect(mocks.createVolume).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.metadata).not.toHaveBeenCalled();
  });

  it("rejects a changed quote before debit, storage creation, or provisioning", async () => {
    const response = await launchInstance(request({ quoteFingerprint: "b".repeat(64) }));
    expect(response.status).toBe(409);
    expect(walletCents).toBe(1000);
    expect(mocks.debit).not.toHaveBeenCalled();
    expect(mocks.createVolume).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not launch without requested storage and refunds its precharge", async () => {
    mocks.createVolume.mockRejectedValue(new Error("Storage unavailable"));
    const response = await launchInstance(request());
    expect(response.status).toBe(500);
    expect(walletCents).toBe(1000);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.removeVolume).not.toHaveBeenCalled();
  });

  it("removes a newly created failed volume and refunds without launching", async () => {
    mocks.volumes.mockResolvedValue([{ id: 42, status: "failed" }]);
    const response = await launchInstance(request());
    expect(response.status).toBe(503);
    expect(walletCents).toBe(1000);
    expect(mocks.removeVolume).toHaveBeenCalledWith(42);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("compensates new storage and wallet when capacity rejects instance creation", async () => {
    mocks.create.mockRejectedValue(new Error("Insufficient resources"));
    const response = await launchInstance(request());
    expect(response.status).toBe(503);
    expect(walletCents).toBe(1000);
    expect(mocks.removeVolume).toHaveBeenCalledWith(42);
    expect(mocks.metadata).not.toHaveBeenCalled();
  });

  it("never deletes the customer's pre-existing storage on failed creation", async () => {
    configuration.storage = { mode: "existing", volumeId: 88 };
    mocks.create.mockRejectedValue(new Error("Insufficient resources"));
    await launchInstance(request());
    expect(walletCents).toBe(1000);
    expect(mocks.createVolume).not.toHaveBeenCalled();
    expect(mocks.removeVolume).not.toHaveBeenCalled();
  });

  it("rejects a missing or foreign SSH key before charging or creating storage", async () => {
    const response = await launchInstance(request({ sshKeyIds: ["foreign-key"] }));
    expect(response.status).toBe(403);
    expect(mocks.debit).not.toHaveBeenCalled();
    expect(mocks.createVolume).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects another account's monthly subscription even when its price matches", async () => {
    resolved.billingType = "monthly";
    mocks.retrieveSubscription.mockResolvedValue({ id: "sub_other", customer: "cus_other", status: "active", items: { data: [{ quantity: 1, price: { id: "price_gpu" } }] } });
    const response = await launchInstance(request({ stripeSubscriptionId: "sub_other" }));
    expect(response.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.createVolume).not.toHaveBeenCalled();
    expect(mocks.debit).not.toHaveBeenCalled();
  });

  it("uses a linked monthly entitlement once without metering or prepayment", async () => {
    resolved.billingType = "monthly";
    resolved.configurationPricing = null;
    quote.rate.instanceHourlyCents = 0;
    quote.rate.prepayCents = 0;
    quote.rate.stoppedInstanceHourlyCents = 0;
    quote.rate.totalHourlyCents = quote.rate.sharedStorageHourlyCents;
    walletCents = -500;
    mocks.retrieveSubscription.mockResolvedValue({ id: "sub_linked", customer: "cus_linked_monthly", status: "active", items: { data: [{ quantity: 1, price: { id: "price_gpu" } }] } });
    const saved: (PodRateInput & { stripeSubscriptionId?: string; instanceId?: string })[] = [];
    mocks.metadata.mockImplementation(async ({ data }) => { saved.push(data); return data; });
    mocks.pods.mockImplementation(async ({ where }) => saved.filter(pod => pod.stripeSubscriptionId === where.stripeSubscriptionId));
    mocks.detail.mockResolvedValue({ id: "instance", status: "running" });
    const response = await launchInstance(request({ stripeSubscriptionId: "sub_linked" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ instance_id: "instance", deploy_status: "provisioning" });
    expect(getPodHourlyRateCents(saved[0], 2)).toBeNull();
    expect(getPodStoppedHourlyRateCents(saved[0], 2, 25)).toBeNull();
    const duplicate = await launchInstance(request({ stripeSubscriptionId: "sub_linked" }));
    expect(duplicate.status).toBe(409);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(walletCents).toBe(-500);
    expect(mocks.debit).not.toHaveBeenCalled();
  });

  it("charges the complete multi-GPU allocation once and leaves it provisioning", async () => {
    const response = await launchInstance(request());
    expect(await response.json()).toMatchObject({ success: true, instance_id: "instance", deploy_status: "provisioning" });
    expect(walletCents).toBe(830);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      instance_type_id: "cpu8",
      root_storage_type_id: "root100",
      pod_opts: { pool_id: 12, vgpus: 2, shared_volumes: [42], rootfs_enabled: true },
    }));
    const persisted = mocks.metadata.mock.calls[0][0].data;
    expect(getPodHourlyRateCents(persisted, 2)).toBe(340);
    expect(getPodStoppedHourlyRateCents(persisted, 2, 99)).toBe(85);
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it("does not request persistent root storage when the selected pool cannot provide it", async () => {
    resolved.podOptions = { rootfsEnabled: false };
    const response = await launchInstance(request());
    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      pod_opts: expect.objectContaining({ pool_id: 12, rootfs_enabled: false }),
    }));
  });

  it("returns and persists the instance ID from a native string creation response", async () => {
    mocks.create.mockResolvedValue("instance");
    const response = await launchInstance(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, instance_id: "instance", deploy_status: "provisioning" });
    expect(mocks.metadata.mock.calls[0][0].data.instanceId).toBe("instance");
  });

  it("removes an accepted instance before compensating a metadata persistence failure", async () => {
    mocks.metadata.mockRejectedValue(new Error("Database unavailable"));
    const response = await launchInstance(request());
    expect(response.status).toBe(500);
    expect(mocks.removeInstance).toHaveBeenCalledWith("instance");
    expect(mocks.removeVolume).toHaveBeenCalledWith(42);
    expect(walletCents).toBe(1000);
    expect(mocks.removeInstance.mock.invocationCallOrder[0]).toBeLessThan(mocks.removeVolume.mock.invocationCallOrder[0]);
  });

  it("exposes an accepted instance without permitting blind retries when persistence and cleanup both fail", async () => {
    mocks.metadata.mockRejectedValue(new Error("Database unavailable"));
    mocks.removeInstance.mockRejectedValue(new Error("Provider cleanup unavailable"));
    const response = await launchInstance(request());
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ success: true, instance_id: "instance", configuration_saved: false, launch_warning: expect.any(String) });
    expect(walletCents).toBe(830);
    expect(mocks.refund).not.toHaveBeenCalled();
    expect(mocks.removeVolume).not.toHaveBeenCalled();
  });

  it("uses native VM GPU-card allocation instead of silently sending pod options", async () => {
    resolved.serviceType = "cpu_gpu_card";
    configuration.gpuModelId = "gpu-model";
    configuration.storage = { mode: "none" };
    const response = await launchInstance(request());
    expect(response.status).toBe(200);
    const submitted = mocks.create.mock.calls[0][0];
    expect(submitted.vm_opts).toEqual({ gpu_card_count: 2, passthrough_accelerators: "gpu-model", networks: [] });
    expect(submitted).not.toHaveProperty("pod_opts");
    expect(walletCents).toBe(830);
  });

  it("retains billing ownership and exposes software setup failure after acceptance", async () => {
    mocks.complete.mockRejectedValue(new Error("Recipe metadata failed"));
    const response = await launchInstance(request());
    expect(await response.json()).toMatchObject({ success: true, instance_id: "instance", software_error: expect.any(String) });
    expect(walletCents).toBe(830);
    expect(mocks.refund).not.toHaveBeenCalled();
    expect(mocks.removeVolume).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith({ where: { instanceId: "instance" }, data: { startupScriptStatus: "failed" } });
  });
});
