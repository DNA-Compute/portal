import type { AuthenticatedCustomer } from "@/lib/auth/helpers";
import type { GpuProduct } from "@prisma/client";
import { resolveOperatingContext } from "@/lib/auth/account-resolver";
import { prisma } from "@/lib/prisma";
import {
  getTeamAccessibleScenarios, getTeamAccessibleLaunchRegions, getScenarioCompatibleServices,
  getServiceCompatibleGpuModels, getServicePoolMaxVgpus, getLaunchServiceResources, getSharedStorageBlocks, getSharedVolumes,
  getServiceCompatibleRegions, getServiceProvisioningInfo, getServiceCompatibleGPUPools,
  type LaunchServiceQuery,
} from "@/lib/hostedai";
import {
  configurationPricingSchema, launchConfigurationSchema,
  type LaunchCapabilities, type LaunchConfiguration, type LaunchImage, type LaunchPool, type LaunchProfile,
  type LaunchStorageBlock, type ResolvedLaunchConfiguration, type ConfigurationPricing,
} from "@/lib/launch-config";

type RecordValue = Record<string, unknown>;
interface ProductContext { product: GpuProduct; pricing: ConfigurationPricing | null; poolIds: number[] }
export class LaunchCapabilityError extends Error {
  constructor(message: string, public status = 400, public code = "INVALID_CONFIGURATION") {
    super(message);
    this.name = "LaunchCapabilityError";
  }
}
function metadata(message: string): never {
  throw new LaunchCapabilityError(`The GPU provider returned incomplete or ambiguous ${message}. Please contact support.`, 502, "PROVIDER_METADATA");
}
function object(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) metadata(label);
  return value as RecordValue;
}
function rows(value: unknown, label: string, key = "items"): RecordValue[] {
  const list = Array.isArray(value) ? value : object(value, label)[key];
  if (!Array.isArray(list)) metadata(label);
  return list.map(item => object(item, label));
}
function text(value: unknown, label: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) metadata(label);
  return String(value);
}
function number(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value))) metadata(label);
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum) metadata(label);
  return result;
}
function integer(value: unknown, label: string, minimum = 1): number {
  const result = number(value, label, minimum);
  if (!Number.isSafeInteger(result)) metadata(label);
  return result;
}
function flag(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") metadata(label);
  return value;
}
function dimension(row: RecordValue, fields: Array<[string, number]>, label: string): number {
  const values = fields.filter(([key]) => row[key] !== undefined && row[key] !== null)
    .map(([key, divisor]) => number(row[key], label, Number.MIN_VALUE) / divisor);
  if (!values.length || values.some(value => value !== values[0])) metadata(label);
  return values[0];
}
function unique<T extends { id: string | number }>(items: T[], label: string): T[] {
  if (new Set(items.map(item => String(item.id))).size !== items.length) metadata(label);
  return items;
}
function available(row: RecordValue): boolean {
  return row.is_available !== false;
}
function profile(row: RecordValue, multiplier: number): LaunchProfile {
  return { id: text(row.id, "profile identifier"), name: text(row.name, "profile name"),
    cpuCores: dimension(row, [["vcpus", 1], ["cpu_cores", 1]], "CPU dimensions") * multiplier,
    ramGb: dimension(row, [["memory_mb", 1024], ["ram_mb", 1024], ["ram_gb", 1]], "RAM dimensions") * multiplier };
}
function block(row: RecordValue, multiplier = 1): LaunchStorageBlock {
  return { id: text(row.id, "storage identifier"), name: text(row.name, "storage name"),
    sizeGb: dimension(row, [["size_in_gb", 1], ["size_gb", 1], ["size", 1]], "storage dimensions") * multiplier };
}
function images(value: unknown): LaunchImage[] {
  // Native compatible-images groups image versions by display name; each version uses hash, not id.
  if (Array.isArray(value)) return unique(rows(value, "images").filter(available).map(row => {
    return { id: text(row.hash, "image hash"), name: text(row.name, "image name") };
  }), "image hashes");
  return unique(Object.entries(object(value, "images")).flatMap(([name, versions]) =>
    rows(versions, "image versions").filter(available).map(row => ({ id: text(row.hash, "image hash"), name: text(row.name ?? name, "image name") }))
  ), "image hashes");
}
async function provider<T>(label: string, request: () => Promise<T>): Promise<T> {
  try { return await request(); } catch (error) {
    if (error instanceof LaunchCapabilityError) throw error;
    console.error(`[Launch capabilities] ${label} unavailable`, error);
    throw new LaunchCapabilityError(`The GPU provider could not check ${label}. Please retry.`, 503, "PROVIDER_UNAVAILABLE");
  }
}
function operatingTeam(auth: AuthenticatedCustomer): string {
  if (!auth.can("gpu.provision")) throw new LaunchCapabilityError("You do not have permission to launch GPUs.", 403, "FORBIDDEN");
  // Never use allTeamIds or a linked monthly account's team for provisioning.
  const teamId = auth.customer.metadata?.hostedai_team_id;
  if (!teamId || auth.teamId !== teamId) throw new LaunchCapabilityError("The active account has no provisioning team.", 403, "FORBIDDEN");
  return teamId;
}
async function permittedProduct(auth: AuthenticatedCustomer, productId: string): Promise<ProductContext> {
  operatingTeam(auth);
  const product = await prisma.gpuProduct.findFirst({ where: { id: productId, active: true } });
  if (!product?.serviceId) throw new LaunchCapabilityError("This GPU offering is no longer available.", 404, "PRODUCT_UNAVAILABLE");
  if (product.billingType !== "hourly" && product.billingType !== "monthly") metadata("product billing type");
  if (!Number.isSafeInteger(product.pricePerHourCents) || product.pricePerHourCents < 0) metadata("GPU pricing");
  let poolIdsValue: unknown;
  try { poolIdsValue = JSON.parse(product.poolIds); } catch { metadata("offering GPU pool mapping"); }
  if (!Array.isArray(poolIdsValue)) metadata("offering GPU pool mapping");
  const poolIds = poolIdsValue.map(id => integer(id, "offering GPU pool identifier"));
  if (new Set(poolIds).size !== poolIds.length) metadata("offering GPU pool mapping");
  const pricing = product.configurationPricing == null ? null : configurationPricingSchema.safeParse(product.configurationPricing);
  if (pricing && !pricing.success) metadata("configuration pricing");
  if (product.billingType === "hourly") {
    if (!["hourly", "free_trial", "free"].includes(auth.customer.metadata?.billing_type || "")) {
      throw new LaunchCapabilityError("This offering requires an hourly wallet on the active account.", 403, "NOT_ENTITLED");
    }
  } else {
    const context = await resolveOperatingContext({ email: auth.payload.email, jwtCustomerId: auth.payload.customerId, activeAccountId: auth.payload.activeAccountId });
    if (!context || context.accountId !== auth.accountId) throw new LaunchCapabilityError("The active billing account changed. Refresh and try again.", 403, "NOT_ENTITLED");
    const customerIds = new Set([auth.accountId, ...context.monthlyCustomerIds]);
    let entitled = false;
    for (const customer of customerIds) {
      for await (const subscription of auth.stripe.subscriptions.list({ customer, status: "active", limit: 100 })) {
        if (subscription.items.data.some(item => item.price.id === product.stripePriceId)) { entitled = true; break; }
      }
      if (entitled) break;
    }
    if (!entitled) throw new LaunchCapabilityError("The active account does not have a paid subscription for this GPU offering.", 403, "NOT_ENTITLED");
  }
  return { product, pricing: pricing && pricing.success ? pricing.data : null, poolIds };
}
async function permittedService(teamId: string, serviceId: string): Promise<LaunchCapabilities["serviceType"]> {
  const scenarios = rows(await provider("permitted services", () => getTeamAccessibleScenarios(teamId)), "scenarios", "scenarios");
  for (const scenario of scenarios) {
    let offset = 0;
    for (;;) {
      const response = await provider("permitted services", () => getScenarioCompatibleServices(text(scenario.id, "scenario identifier"), teamId, 100, offset));
      const services = rows(response, "services", "services");
      const service = services.find(item => String(item.id) === serviceId && item.is_active !== false && available(item));
      if (service) {
        if (service.service_type !== "pod_accelerator" && service.service_type !== "cpu_gpu_card") {
          throw new LaunchCapabilityError("This service does not support GPU instance launches.", 409, "UNSUPPORTED_SERVICE");
        }
        return service.service_type;
      }
      if (Array.isArray(response) || !response.has_more_batches) break;
      const next = integer(response.next_offset, "service pagination", 0);
      if (next <= offset) metadata("service pagination");
      offset = next;
    }
  }
  throw new LaunchCapabilityError("This GPU service is not permitted for the active team.", 403, "SERVICE_NOT_PERMITTED");
}
export interface LaunchCapabilitySelection { gpuCount?: number; gpuSharePercent?: number; imageHash?: string; instanceTypeId?: string }

async function discover(
  auth: AuthenticatedCustomer, context: ProductContext, serviceId: string,
  regionId?: number, poolId?: number, gpuModelId?: string, selection: LaunchCapabilitySelection = {},
): Promise<LaunchCapabilities> {
  const teamId = operatingTeam(auth);
  const serviceType = await permittedService(teamId, serviceId);
  const [regionResponse, teamRegionResponse] = await Promise.all([
    provider("service regions", () => getServiceCompatibleRegions(serviceId, teamId)),
    provider("team regions", () => getTeamAccessibleLaunchRegions(teamId)),
  ]);
  const teamRegionIds = new Set(rows(teamRegionResponse, "team regions", "regions").map(row => integer(row.id, "region identifier")));
  const regions = unique(rows(regionResponse, "service regions", "regions")
    .filter(row => available(row) && teamRegionIds.has(integer(row.id, "region identifier")))
    .map(row => ({ id: integer(row.id, "region identifier"), name: text(row.region_name ?? row.name, "region name"),
      ...(typeof row.country === "string" ? { country: row.country } : {}) })), "regions");
  const fixed = context.product.billingType === "monthly";
  const capabilities: LaunchCapabilities = {
    productId: context.product.id, serviceType, regions, profiles: [], images: [], rootStorageBlocks: [],
    sharedStorageBlocks: [], volumes: [], pools: [], gpuModels: [], maxGpuCount: 0,
    locks: { profile: fixed, image: fixed, rootStorage: fixed, pool: fixed, gpuCount: fixed }, defaults: {}, includedAllocation: {},
  };
  if (regionId === undefined) return capabilities;
  if (!regions.some(region => region.id === regionId)) throw new LaunchCapabilityError("The selected region is not available for this GPU and active team.", 409, "REGION_UNAVAILABLE");
  capabilities.regionId = regionId;
  const info = object(await provider("service defaults", () => getServiceProvisioningInfo(serviceId, teamId, regionId)), "provisioning metadata");
  if (info.service_type !== serviceType) metadata("service type");
  if (serviceType === "cpu_gpu_card" && info.auto_assign_network !== "both") {
    throw new LaunchCapabilityError("This GPU VM service requires manual network configuration, which is not supported by Launch GPU. Ask an administrator to enable automatic network assignment.", 409, "UNSUPPORTED_NETWORK_CONFIGURATION");
  }
  const profileDetails = object(info.instance_type_details, "CPU/RAM defaults");
  const imageDetails = info.image_details == null ? null : object(info.image_details, "image defaults");
  const rootDetails = object(info.storage_block_details, "root storage defaults");
  const gpuDetails = object(serviceType === "pod_accelerator" ? info.gpu_pool_details : info.accelerator_info, "GPU defaults");
  const gpuDefault = serviceType === "pod_accelerator"
    ? (Array.isArray(gpuDetails.default) && gpuDetails.default.length === 1 ? object(gpuDetails.default[0], "default pool") : null)
    : (gpuDetails.default ? object(gpuDetails.default, "default GPU") : null);
  if (serviceType === "cpu_gpu_card" && !gpuDefault) metadata("offering GPU model binding");
  capabilities.locks = {
    profile: flag(profileDetails.is_locked, "profile lock") || fixed,
    image: (imageDetails === null ? false : flag(imageDetails.is_locked, "image lock")) || fixed,
    rootStorage: flag(rootDetails.is_locked, "root storage lock") || fixed,
    pool: flag(serviceType === "pod_accelerator" ? gpuDetails.is_locked : gpuDefault?.is_locked, "GPU lock") || fixed,
    gpuCount: flag(gpuDetails.is_quantity_locked, "GPU quantity lock") || fixed,
  };
  const defaultId = (details: RecordValue | null, key: string): string | undefined => details?.default == null ? undefined : text(object(details.default, "resource default")[key], "default identifier");
  capabilities.defaults = {
    instanceTypeId: defaultId(profileDetails, "id"), imageHash: defaultId(imageDetails, "hash"),
    rootStorageBlockId: defaultId(rootDetails, "id"),
    gpuCount: gpuDetails.quantity == null ? undefined : integer(gpuDetails.quantity, "default GPU quantity"),
    ...(serviceType === "pod_accelerator" ? { poolId: gpuDefault ? integer(gpuDefault.id, "default pool") : undefined }
      : { gpuModelId: gpuDefault ? text(gpuDefault.model_id, "default GPU model") : undefined }),
  };
  // Selections advance UI defaults below, but cannot redefine what the product price includes.
  capabilities.includedAllocation = { ...capabilities.defaults };
  const requireDefault = (locked: boolean, value: unknown, label: string) => { if (locked && value === undefined) metadata(label); };
  requireDefault(capabilities.locks.profile, capabilities.defaults.instanceTypeId, "locked profile default");
  requireDefault(capabilities.locks.image, capabilities.defaults.imageHash, "locked image default");
  requireDefault(capabilities.locks.rootStorage, capabilities.defaults.rootStorageBlockId, "locked root storage default");
  requireDefault(capabilities.locks.pool, serviceType === "pod_accelerator" ? capabilities.defaults.poolId : capabilities.defaults.gpuModelId, "locked GPU default");
  requireDefault(capabilities.locks.gpuCount, capabilities.defaults.gpuCount, "locked GPU quantity");
  const query: LaunchServiceQuery = { service_id: serviceId, team_id: teamId, region_id: regionId };
  const maximum = Math.min(integer(gpuDetails.max_quantity, "maximum GPU quantity", 0), 256);
  // Rates and catalog memory describe this offering's hardware, not every GPU in its service.
  const catalogVram = context.product.vramGb == null ? undefined : number(context.product.vramGb, "offering GPU memory", Number.MIN_VALUE);
  const hardwareMemory = (row: RecordValue): { vramGb?: number } => {
    const providerVram = row.vram_gb == null ? undefined : number(row.vram_gb, "GPU memory", Number.MIN_VALUE);
    const vramGb = catalogVram === undefined ? providerVram : providerVram === undefined ? catalogVram : Math.min(catalogVram, providerVram);
    return vramGb === undefined ? {} : { vramGb };
  };
  if (serviceType === "pod_accelerator") {
    if (gpuModelId !== undefined) throw new LaunchCapabilityError("A pod offering requires a GPU pool, not a VM GPU model.");
    const offeredPoolIds = new Set(context.poolIds.length ? context.poolIds : [integer(gpuDefault?.id, "offering default GPU pool binding")]);
    const pools = rows(await provider("GPU pool capacity", () => getServiceCompatibleGPUPools(serviceId, teamId, regionId)), "GPU pools");
    // Fractional shares are priced only from a rate card; bundles and monthly plans include a whole GPU.
    const priceFractions = context.pricing !== null && !fixed;
    const offeredPools = await Promise.all(pools.map(async row => {
      if (!available(row)) return null;
      const id = integer(row.id, "pool identifier");
      if (!offeredPoolIds.has(id)) return null;
      if (capabilities.locks.pool && id !== capabilities.defaults.poolId) return null;
      const ratioValue = row.sharing_ratio ?? row.oversubscription_ratio;
      if (ratioValue === undefined) metadata("GPU sharing ratio");
      const ratio = integer(ratioValue, "GPU sharing ratio", 0);
      let capacity: number;
      let gpuShares: LaunchPool["gpuShares"];
      if (row.scheduler_mode === "disabled" && ratio <= 1) {
        capacity = integer(row.available_vgpus, "available GPU quantity", 0);
      } else if (row.scheduler_mode === "user_selected" && ratio >= 1) {
        const settings = object(row.scheduler_mode_settings, "GPU scheduling settings");
        let percents: number[];
        if (flag(settings.locked_to_minimum_guarantee, "GPU share lock")) {
          percents = [integer(settings.default_minimum_guarantee, "locked GPU share")];
        } else if (row.available_tq_percentages !== undefined) {
          if (!Array.isArray(row.available_tq_percentages)) metadata("available GPU shares");
          percents = row.available_tq_percentages.map(value => integer(value, "GPU share"));
        } else {
          percents = [100];
        }
        // A share must map onto whole time slices (tq_slices = ratio × share), or it cannot be reserved exactly.
        percents = [...new Set(percents)].filter(percent => percent <= 100 && (percent === 100 || priceFractions) && Number.isInteger(ratio * percent / 100))
          .sort((a, b) => b - a);
        if (!percents.length) return null;
        gpuShares = await Promise.all(percents.map(async percent => {
          const slices = ratio * percent / 100;
          const max = integer(await provider("GPU share capacity", () => getServicePoolMaxVgpus({ ...query, pool_id: id }, slices)), "GPU share capacity", 0);
          // A fractional share is one guaranteed slice of one GPU, never a multi-GPU allocation.
          return { percent, maxGpuCount: percent === 100 ? Math.min(max, maximum || 256) : Math.min(max, 1) };
        }));
        capacity = gpuShares.find(share => share.percent === 100)?.maxGpuCount ?? Math.max(...gpuShares.map(share => share.maxGpuCount));
      } else {
        // VIP/time-sharing modes cannot promise any guaranteed allocation priced here.
        return null;
      }
      return { id, name: text(row.pool_label ?? row.pool_name ?? row.name, "pool name"),
        // Native pod max_quantity=0 removes only the service cap, never the pool capacity cap.
        maxGpuCount: Math.min(capacity, maximum || 256), ...(gpuShares ? { gpuShares } : {}),
        // Capability flags gate marketplace storage only; absent flags retain legacy defaults.
        rootfsEnabled: row.pool_source !== "marketplace" || row.rootfs_persistence_capable === undefined || flag(row.rootfs_persistence_capable, "root persistence capability"),
        sharedStorageEnabled: row.pool_source !== "marketplace" || row.shared_storage_capable === undefined || flag(row.shared_storage_capable, "shared storage capability"),
        ...hardwareMemory(row) };
    }));
    capabilities.pools = unique(offeredPools.filter(pool => pool !== null), "GPU pools");
    query.pool_id = poolId ?? capabilities.pools.find(pool => pool.id === capabilities.defaults.poolId)?.id ?? (capabilities.pools.length === 1 ? capabilities.pools[0].id : undefined);
    if (query.pool_id !== undefined && !capabilities.pools.some(pool => pool.id === query.pool_id)) throw new LaunchCapabilityError("The selected pool is unavailable or does not provide supported whole-GPU allocations.", 409, "GPU_UNAVAILABLE");
    capabilities.defaults.poolId = query.pool_id;
    const pool = capabilities.pools.find(item => item.id === query.pool_id);
    capabilities.maxGpuCount = pool === undefined ? Math.max(0, ...capabilities.pools.map(item => item.maxGpuCount)) : pool.maxGpuCount;
    if (pool?.gpuShares) {
      const percent = selection.gpuSharePercent ?? (pool.gpuShares.some(share => share.percent === 100) ? 100 : pool.gpuShares[0].percent);
      const share = pool.gpuShares.find(item => item.percent === percent);
      if (!share) throw new LaunchCapabilityError("The selected GPU share is not offered for this pool. Refresh the configuration.", 409, "GPU_UNAVAILABLE");
      capabilities.defaults.gpuSharePercent = percent;
      capabilities.maxGpuCount = share.maxGpuCount;
    } else if (selection.gpuSharePercent !== undefined && selection.gpuSharePercent !== 100) {
      throw new LaunchCapabilityError("This GPU pool offers whole GPUs only.", 409, "GPU_UNAVAILABLE");
    }
  } else {
    if (poolId !== undefined) throw new LaunchCapabilityError("A GPU VM offering requires a GPU model, not a pod pool.");
    if (selection.gpuSharePercent !== undefined && selection.gpuSharePercent !== 100) throw new LaunchCapabilityError("GPU VM offerings provide whole GPUs only.", 409, "GPU_UNAVAILABLE");
    capabilities.locks.pool = true;
    capabilities.gpuModels = unique(rows(await provider("GPU models", () => getServiceCompatibleGpuModels(query)), "GPU models")
      .filter(row => available(row) && String(row.model_id) === capabilities.defaults.gpuModelId)
      .map(row => ({ id: text(row.model_id, "GPU model identifier"), name: text(row.model_name, "GPU model name"),
        maxGpuCount: maximum,
        ...hardwareMemory(row) })), "GPU models");
    query.model_id = gpuModelId ?? capabilities.defaults.gpuModelId ?? (capabilities.gpuModels.length === 1 ? capabilities.gpuModels[0].id : undefined);
    if (query.model_id !== undefined && !capabilities.gpuModels.some(model => model.id === query.model_id)) throw new LaunchCapabilityError("The selected GPU model is unavailable for this service and region.", 409, "GPU_UNAVAILABLE");
    capabilities.defaults.gpuModelId = query.model_id;
    capabilities.maxGpuCount = capabilities.gpuModels.length ? maximum : 0;
  }
  if (capabilities.locks.gpuCount) capabilities.maxGpuCount = Math.min(capabilities.maxGpuCount, capabilities.defaults.gpuCount!);
  if (!capabilities.maxGpuCount) return capabilities;
  query.requested_gpu_count = selection.gpuCount ?? capabilities.defaults.gpuCount;
  if (query.requested_gpu_count === undefined) metadata("default GPU quantity");
  if (!Number.isSafeInteger(query.requested_gpu_count) || query.requested_gpu_count < 1 || query.requested_gpu_count > capabilities.maxGpuCount ||
    (capabilities.locks.gpuCount && query.requested_gpu_count !== capabilities.defaults.gpuCount)) {
    throw new LaunchCapabilityError("The requested GPU quantity is not available for this offering. Refresh the configuration.", 409, "GPU_UNAVAILABLE");
  }
  if (query.pool_id === undefined && query.model_id === undefined) return capabilities;
  const restrict = <T extends { id: string }>(items: T[], locked: boolean, id: string | undefined): T[] => locked ? items.filter(item => item.id === id) : items;
  capabilities.images = restrict(images(await provider("compatible images", () => getLaunchServiceResources("compatible-images", query))), capabilities.locks.image, capabilities.defaults.imageHash);
  query.image_hash = selection.imageHash ?? capabilities.images.find(image => image.id === capabilities.defaults.imageHash)?.id ?? (capabilities.images.length === 1 ? capabilities.images[0].id : undefined);
  if (query.image_hash !== undefined && !capabilities.images.some(image => image.id === query.image_hash)) throw new LaunchCapabilityError("The selected image is not supported for this GPU configuration.", 409);
  if (query.image_hash === undefined) return capabilities;
  capabilities.defaults.imageHash = query.image_hash;
  const gpuScale = (details: RecordValue) => details.gpu_scaling !== undefined && flag(details.gpu_scaling, "GPU resource scaling") ? query.requested_gpu_count! : 1;
  capabilities.profiles = restrict(unique(rows(await provider("CPU/RAM profiles", () => getLaunchServiceResources("instance-types", query)), "CPU/RAM profiles")
    .filter(available).map(row => profile(row, gpuScale(profileDetails))), "profiles"), capabilities.locks.profile, capabilities.defaults.instanceTypeId);
  query.instance_type = selection.instanceTypeId ?? capabilities.profiles.find(item => item.id === capabilities.defaults.instanceTypeId)?.id ?? (capabilities.profiles.length === 1 ? capabilities.profiles[0].id : undefined);
  if (query.instance_type !== undefined && !capabilities.profiles.some(item => item.id === query.instance_type)) throw new LaunchCapabilityError("The selected CPU/RAM profile is not supported for this image and GPU configuration.", 409);
  if (query.instance_type === undefined) return capabilities;
  capabilities.defaults.instanceTypeId = query.instance_type;
  capabilities.rootStorageBlocks = restrict(unique(rows(await provider("root storage", () => getLaunchServiceResources("storage-blocks", query)), "root storage")
    .filter(available).map(row => block(row, gpuScale(rootDetails))), "root storage blocks"), capabilities.locks.rootStorage, capabilities.defaults.rootStorageBlockId);
  if (!capabilities.defaults.rootStorageBlockId && capabilities.rootStorageBlocks.length === 1) capabilities.defaults.rootStorageBlockId = capabilities.rootStorageBlocks[0].id;
  if (auth.can("storage.manage") && serviceType === "pod_accelerator" && capabilities.pools.find(pool => pool.id === query.pool_id)?.sharedStorageEnabled) {
    let lookups: [unknown, unknown, unknown];
    try {
      lookups = await Promise.all([
        provider("shared storage", () => getSharedStorageBlocks(regionId, teamId)),
        provider("owned shared volumes", () => getSharedVolumes(teamId)),
        provider("attachable shared volumes", () => getLaunchServiceResources("shared-volumes", query)),
      ]);
    } catch (error) {
      // Shared storage is optional: a region without a storage node must not block a GPU launch.
      if (!(error instanceof LaunchCapabilityError) || error.code !== "PROVIDER_UNAVAILABLE") throw error;
      capabilities.sharedStorageUnavailable = true;
      return capabilities;
    }
    const [blocks, owned, compatible] = lookups;
    capabilities.sharedStorageBlocks = unique(rows(blocks, "shared storage").filter(available).map(row => block(row)), "shared storage blocks");
    const compatibleIds = new Set(rows(compatible, "compatible shared volumes").map(row => integer(row.id, "volume identifier")));
    capabilities.volumes = unique(rows(owned, "owned shared volumes").filter(row =>
      row.team_id === teamId && row.region_id === regionId && compatibleIds.has(integer(row.id, "volume identifier")) &&
      typeof row.status === "string" && ["available", "ready", "active"].includes(row.status.toLowerCase())
    ).map(row => ({ id: integer(row.id, "volume identifier"), name: text(row.name, "volume name"),
      sizeGb: dimension(row, [["size_in_gb", 1], ["size_gb", 1]], "volume dimensions"), regionId, status: text(row.status, "volume status") })), "shared volumes");
  }
  return capabilities;
}
export async function getLaunchCapabilities(auth: AuthenticatedCustomer, productId: string, regionId?: number, poolId?: number, gpuModelId?: string, selection: LaunchCapabilitySelection = {}): Promise<LaunchCapabilities> {
  const context = await permittedProduct(auth, productId);
  return discover(auth, context, context.product.serviceId!, regionId, poolId, gpuModelId, selection);
}
function selected<T extends { id: string | number }>(items: T[], id: string | number | undefined, label: string): T {
  const item = items.find(candidate => candidate.id === id);
  if (!item) throw new LaunchCapabilityError(`The selected ${label} is unavailable or incompatible. Refresh the configuration.`, 409, "RESOURCE_UNAVAILABLE");
  return item;
}
function resolveResources(configuration: LaunchConfiguration, capabilities: LaunchCapabilities) {
  if (!capabilities.maxGpuCount || configuration.gpuCount > capabilities.maxGpuCount) throw new LaunchCapabilityError("No capacity is available for the requested GPU quantity.", 409, "NO_CAPACITY");
  const gpu = capabilities.serviceType === "pod_accelerator" ? selected(capabilities.pools, configuration.poolId, "GPU pool") : selected(capabilities.gpuModels, configuration.gpuModelId, "GPU model");
  const sharePercent = configuration.gpuSharePercent ?? 100;
  if ("gpuShares" in gpu && gpu.gpuShares ? !gpu.gpuShares.some(share => share.percent === sharePercent) : sharePercent !== 100) {
    throw new LaunchCapabilityError("The selected GPU share is unavailable. Refresh the configuration.", 409, "RESOURCE_UNAVAILABLE");
  }
  let sharedStorage: ResolvedLaunchConfiguration["sharedStorage"] = null;
  if (configuration.storage.mode === "new") {
    const item = selected(capabilities.sharedStorageBlocks, configuration.storage.blockId, "shared storage block");
    sharedStorage = { blockId: item.id, name: item.name, sizeGb: item.sizeGb };
  } else if (configuration.storage.mode === "existing") {
    const item = selected(capabilities.volumes, configuration.storage.volumeId, "owned, ready shared volume");
    sharedStorage = { id: item.id, name: item.name, sizeGb: item.sizeGb };
  }
  return { profile: selected(capabilities.profiles, configuration.instanceTypeId, "CPU/RAM profile"),
    image: selected(capabilities.images, configuration.imageHash, "image"),
    rootStorage: selected(capabilities.rootStorageBlocks, configuration.rootStorageBlockId, "root storage block"),
    sharedStorage, gpuName: gpu.name, gpuVramGb: gpu.vramGb ?? null,
    podOptions: "rootfsEnabled" in gpu
      // Time-sliced pools always state the reserved share; dedicated pools need none.
      ? { rootfsEnabled: gpu.rootfsEnabled, ...(gpu.gpuShares ? { guaranteedGpuSharePercent: sharePercent } : {}) }
      : undefined };
}
export async function resolveLaunchConfiguration(auth: AuthenticatedCustomer, input: LaunchConfiguration): Promise<ResolvedLaunchConfiguration> {
  const parsed = launchConfigurationSchema.safeParse(input);
  if (!parsed.success) throw new LaunchCapabilityError("The launch configuration is invalid.");
  const configuration = parsed.data;
  if (configuration.storage.mode !== "none" && !auth.can("storage.manage")) throw new LaunchCapabilityError("You do not have permission to create or attach shared storage.", 403, "FORBIDDEN");
  const context = await permittedProduct(auth, configuration.productId);
  const capabilities = await discover(auth, context, context.product.serviceId!, configuration.regionId, configuration.poolId, configuration.gpuModelId, configuration);
  const resources = resolveResources(configuration, capabilities);
  if (context.product.billingType === "hourly" && !context.pricing) {
    const included = capabilities.includedAllocation;
    if (configuration.instanceTypeId !== included.instanceTypeId || configuration.imageHash !== included.imageHash ||
      configuration.rootStorageBlockId !== included.rootStorageBlockId || configuration.gpuCount !== included.gpuCount ||
      (configuration.gpuSharePercent ?? 100) !== 100) {
      throw new LaunchCapabilityError("Pricing is not available for this resource allocation. Select the included allocation or contact support.", 422, "RESOURCE_PRICING_UNAVAILABLE");
    }
  }
  return { configuration, serviceId: context.product.serviceId!, serviceType: capabilities.serviceType,
    productName: context.product.name, billingType: context.product.billingType as "hourly" | "monthly",
    gpuBaseHourCents: context.product.pricePerHourCents, configurationPricing: context.product.billingType === "monthly" ? null : context.pricing,
    ...resources };
}
/** Recipe services must support precisely the allocation already quoted, not silently replace it. */
export async function assertServiceSupportsLaunch(auth: AuthenticatedCustomer, resolved: ResolvedLaunchConfiguration, serviceId: string): Promise<void> {
  const context = await permittedProduct(auth, resolved.configuration.productId);
  const configuration = resolved.configuration;
  const capabilities = await discover(auth, context, serviceId, configuration.regionId, configuration.poolId, configuration.gpuModelId, configuration);
  const resources = resolveResources(configuration, capabilities);
  if (capabilities.serviceType !== resolved.serviceType || resources.profile.cpuCores !== resolved.profile.cpuCores || resources.profile.ramGb !== resolved.profile.ramGb || resources.rootStorage.sizeGb !== resolved.rootStorage.sizeGb || resources.podOptions?.rootfsEnabled !== resolved.podOptions?.rootfsEnabled || resources.podOptions?.guaranteedGpuSharePercent !== resolved.podOptions?.guaranteedGpuSharePercent) {
    throw new LaunchCapabilityError("This managed recipe changes the quoted allocation. Choose a compatible recipe or GPU offering.", 409, "RECIPE_INCOMPATIBLE");
  }
}
