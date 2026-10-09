import { z } from "zod";

const identifier = z.string().trim().min(1).max(256);
const rate = z.number().finite().nonnegative().max(100_000_000);

/** GPU base price remains GpuProduct.pricePerHourCents; these are additive rates. */
export const configurationPricingSchema = z.object({
  cpuCoreHourCents: rate,
  ramGbHourCents: rate,
  rootGbHourCents: rate,
  /** Opt-in: sell guaranteed shares of time-sliced GPUs at that fraction of the GPU base price. */
  fractionalGpu: z.boolean().optional(),
}).strict();
export type ConfigurationPricing = z.infer<typeof configurationPricingSchema>;

export const launchSoftwareSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("startup"), presetId: identifier.optional(), script: z.string().max(65_536).optional() }).strict(),
  z.object({ kind: z.literal("recipe"), appId: identifier }).strict(),
  z.object({ kind: z.literal("huggingface"), hfItemId: identifier, hfToken: z.string().max(1024).optional(), openWebUI: z.boolean().optional(), netdata: z.boolean().optional() }).strict(),
]);
export type LaunchSoftware = z.infer<typeof launchSoftwareSchema>;

export const launchStorageSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }).strict(),
  z.object({ mode: z.literal("new"), blockId: identifier }).strict(),
  z.object({ mode: z.literal("existing"), volumeId: z.number().int().positive() }).strict(),
]);
export type LaunchStorage = z.infer<typeof launchStorageSchema>;

export const launchConfigurationSchema = z.object({
  productId: identifier,
  regionId: z.number().int().positive(),
  instanceTypeId: identifier,
  imageHash: identifier,
  rootStorageBlockId: identifier,
  gpuCount: z.number().int().min(1).max(256),
  /** Guaranteed share of one time-sliced GPU; omitted means a whole GPU. */
  gpuSharePercent: z.number().int().min(1).max(100).optional(),
  poolId: z.number().int().positive().optional(),
  gpuModelId: identifier.optional(),
  storage: launchStorageSchema,
  software: launchSoftwareSchema,
}).strict();
export type LaunchConfiguration = z.infer<typeof launchConfigurationSchema>;

export const configuredLaunchSchema = z.object({
  configuration: launchConfigurationSchema,
  quoteFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().trim().min(1).max(128),
  sshKeyIds: z.array(identifier).max(50).default([]),
  stripeSubscriptionId: identifier.optional(),
}).strict();
export type ConfiguredLaunchRequest = z.infer<typeof configuredLaunchSchema>;

export interface LaunchRegion { id: number; name: string; country?: string }
export interface LaunchProfile { id: string; name: string; cpuCores: number; ramGb: number }
export interface LaunchImage { id: string; name: string }
export interface LaunchStorageBlock { id: string; name: string; sizeGb: number }
export interface LaunchVolume { id: number; name: string; sizeGb: number; regionId: number; status: string }
/** guaranteed: a scheduler reserves this compute; otherwise the share is one of `ratio` equal slots on one GPU. */
export interface LaunchGpuShare { percent: number; maxGpuCount: number; guaranteed: boolean }
export interface LaunchPool {
  id: number; name: string; maxGpuCount: number; rootfsEnabled: boolean; sharedStorageEnabled: boolean; vramGb?: number;
  /** Present only for shared pools: the shares this offering can price, largest first. */
  gpuShares?: LaunchGpuShare[];
}
export interface LaunchGpuModel { id: string; name: string; vramGb?: number; maxGpuCount?: number }
export interface LaunchCapabilities {
  productId: string;
  serviceType: "pod_accelerator" | "cpu_gpu_card";
  regions: LaunchRegion[];
  regionId?: number;
  profiles: LaunchProfile[];
  images: LaunchImage[];
  rootStorageBlocks: LaunchStorageBlock[];
  sharedStorageBlocks: LaunchStorageBlock[];
  volumes: LaunchVolume[];
  /** The provider could not report shared storage, so none is offered for this launch. */
  sharedStorageUnavailable?: boolean;
  pools: LaunchPool[];
  gpuModels: LaunchGpuModel[];
  maxGpuCount: number;
  locks: { profile: boolean; image: boolean; rootStorage: boolean; pool: boolean; gpuCount: boolean };
  defaults: { instanceTypeId?: string; imageHash?: string; rootStorageBlockId?: string; poolId?: number; gpuModelId?: string; gpuCount?: number; gpuSharePercent?: number };
  /** Original service defaults covered by a bundled price, not the current selections. */
  includedAllocation: LaunchCapabilities["defaults"];
}

/** Provider-resolved resources, never dimensions accepted from the browser. */
export interface ResolvedLaunchConfiguration {
  configuration: LaunchConfiguration;
  serviceId: string;
  serviceType: LaunchCapabilities["serviceType"];
  podOptions?: { rootfsEnabled: boolean; gpuShare?: { percent: number; guaranteed: boolean } };
  productName: string;
  billingType: "hourly" | "monthly";
  gpuBaseHourCents: number;
  configurationPricing: ConfigurationPricing | null;
  profile: LaunchProfile;
  image: LaunchImage;
  rootStorage: LaunchStorageBlock;
  sharedStorage: { id?: number; blockId?: string; sizeGb: number; name: string } | null;
  gpuName: string;
  gpuVramGb: number | null;
}

export interface LaunchPriceLine {
  key: "gpu" | "cpu" | "ram" | "root" | "shared" | "included";
  label: string;
  quantity: number;
  unit: string;
  unitRateCents: number;
  hourlyCents: number;
  separatelyMetered: boolean;
}
export interface LaunchRateSnapshot {
  version: 1;
  currency: "USD";
  basis: "per_instance";
  instanceHourlyCents: number;
  sharedStorageHourlyCents: number;
  totalHourlyCents: number;
  stoppedInstanceHourlyCents: number;
  stoppedRatePercent: number;
  minimumBillingMinutes: number;
  prepayCents: number;
  lines: LaunchPriceLine[];
}
export interface LaunchQuote {
  fingerprint: string;
  configuration: LaunchConfiguration;
  resources: { gpuName: string; gpuCount: number; gpuSharePercent: number; cpuCores: number; ramGb: number; rootStorageGb: number; sharedStorageGb: number; imageName: string };
  rate: LaunchRateSnapshot;
  warnings: string[];
}

/** Quotes and saved allocations must not duplicate executable secrets. */
export function withoutLaunchSecrets(configuration: LaunchConfiguration): LaunchConfiguration {
  if (configuration.software.kind === "startup") {
    return { ...configuration, software: { kind: "startup", presetId: configuration.software.presetId } };
  }
  if (configuration.software.kind !== "huggingface") return configuration;
  const { hfItemId, openWebUI, netdata } = configuration.software;
  return { ...configuration, software: { kind: "huggingface", hfItemId, openWebUI, netdata } };
}
