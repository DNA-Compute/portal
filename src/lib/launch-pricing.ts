import { createHash } from "node:crypto";
import {
  configurationPricingSchema,
  launchConfigurationSchema,
  withoutLaunchSecrets,
  type LaunchQuote,
  type LaunchPriceLine,
  type LaunchRateSnapshot,
  type ResolvedLaunchConfiguration,
} from "./launch-config";
/** Recomputed at launch: changes to allocation, account or prices need review. */
export function quoteResolvedConfiguration(
  resolved: ResolvedLaunchConfiguration,
  accountId: string,
  teamId: string,
  sharedStorageGbHourCents: number,
  stoppedRatePercent: number,
): LaunchQuote {
  const configuration = withoutLaunchSecrets(launchConfigurationSchema.parse(resolved.configuration));
  const rate = calculateLaunchRate(resolved, sharedStorageGbHourCents, stoppedRatePercent);
  const resources = {
    gpuName: resolved.gpuName,
    gpuCount: configuration.gpuCount,
    cpuCores: resolved.profile.cpuCores,
    ramGb: resolved.profile.ramGb,
    rootStorageGb: resolved.rootStorage.sizeGb,
    sharedStorageGb: resolved.sharedStorage?.sizeGb ?? 0,
    imageName: resolved.image.name,
  };
  const fingerprint = createHash("sha256").update(JSON.stringify({
    accountId,
    teamId,
    serviceId: resolved.serviceId,
    serviceType: resolved.serviceType,
    podOptions: resolved.podOptions,
    billingType: resolved.billingType,
    configuration,
    resources,
    rate,
  })).digest("hex");
  const warnings: string[] = [];
  if (resolved.podOptions?.rootfsEnabled === false) {
    warnings.push("This pool does not support root-filesystem persistence. Do not rely on root-disk files surviving restarts.");
  }
  if (linesNeedHourlyRounding(rate.lines)) {
    warnings.push("Compute resource components are rounded to the nearest cent per hour. Persistent shared storage retains fractional-cent metering.");
  }
  if (resolved.sharedStorage) {
    warnings.push("Persistent storage is metered separately at the current storage rate until the volume is deleted, including while the instance is stopped.");
    if (configuration.storage.mode === "existing") {
      warnings.push("This existing volume is already billed to your team. Attaching it does not create a second storage charge.");
    }
  }
  if (configuration.software.kind !== "none") {
    warnings.push("Compute billing begins when the instance is provisioned; software installation time is included in billable usage.");
  }
  if (resolved.billingType === "monthly") {
    warnings.push("Your active subscription covers its included compute allocation. Any persistent storage is billed separately.");
  }
  return { fingerprint, configuration, resources, rate, warnings };
}

function linesNeedHourlyRounding(lines: LaunchPriceLine[]): boolean {
  return lines.some(line => !line.separatelyMetered && Math.abs(line.quantity * line.unitRateCents - line.hourlyCents) > 0.000001);
}

export const MINIMUM_LAUNCH_BILLING_MINUTES = 30;
const MAX_STORED_CENTS = 2_147_483_647;

export class LaunchPricingError extends Error {
  readonly status = 422;
}

function nonnegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new LaunchPricingError(`${label} has no valid configured rate.`);
  }
  return value;
}

function hourlyLine(
  key: LaunchPriceLine["key"],
  label: string,
  quantity: number,
  unit: string,
  unitRateCents: number,
  separatelyMetered = false,
): LaunchPriceLine {
  nonnegative(quantity, `${label} quantity`);
  nonnegative(unitRateCents, label);
  const raw = quantity * unitRateCents;
  if (!Number.isFinite(raw) || raw > MAX_STORED_CENTS) {
    throw new LaunchPricingError("This configuration exceeds the supported billing amount.");
  }
  // Instance components are quoted at an agreed whole-cent hourly rate. Shared
  // volumes keep sub-cent rates because their existing meter carries fractions.
  const hourlyCents = separatelyMetered ? Math.round(raw * 1_000_000) / 1_000_000 : Math.round(raw);
  return { key, label, quantity, unit, unitRateCents, hourlyCents, separatelyMetered };
}

export function calculateLaunchRate(
  resolved: ResolvedLaunchConfiguration,
  sharedStorageGbHourCents: number,
  stoppedRatePercent: number,
  minimumBillingMinutes = MINIMUM_LAUNCH_BILLING_MINUTES,
): LaunchRateSnapshot {
  if (!Number.isInteger(resolved.configuration.gpuCount) || resolved.configuration.gpuCount < 1) {
    throw new LaunchPricingError("A supported whole GPU quantity is required.");
  }
  if (!Number.isFinite(stoppedRatePercent) || stoppedRatePercent < 0 || stoppedRatePercent > 100) {
    throw new LaunchPricingError("Stopped-instance pricing is not configured correctly.");
  }
  if (!Number.isInteger(minimumBillingMinutes) || minimumBillingMinutes < 1 || minimumBillingMinutes > 1440) {
    throw new LaunchPricingError("The minimum billing interval is invalid.");
  }
  const monthly = resolved.billingType === "monthly";
  const lines: LaunchPriceLine[] = [];
  if (monthly) {
    if (resolved.configurationPricing !== null) {
      throw new LaunchPricingError("Monthly entitlements cannot include unpriced configuration upgrades.");
    }
    lines.push(hourlyLine("included", "Compute included in your subscription", 1, "instance", 0));
  } else {
    if (!Number.isSafeInteger(resolved.gpuBaseHourCents)) {
      throw new LaunchPricingError("GPU pricing must be configured in whole cents.");
    }
    lines.push(hourlyLine(
      "gpu",
      resolved.configurationPricing === null ? "GPU preset (CPU, RAM and root disk included)" : "GPU",
      resolved.configuration.gpuCount,
      "GPU-hour",
      resolved.gpuBaseHourCents,
    ));
    if (resolved.configurationPricing !== null) {
      const parsed = configurationPricingSchema.safeParse(resolved.configurationPricing);
      if (!parsed.success) throw new LaunchPricingError("This offering needs a complete resource rate card.");
      const rates = parsed.data;
      if (!Number.isInteger(resolved.profile.cpuCores) || resolved.profile.cpuCores < 1 ||
          !Number.isFinite(resolved.profile.ramGb) || resolved.profile.ramGb <= 0 ||
          !Number.isFinite(resolved.rootStorage.sizeGb) || resolved.rootStorage.sizeGb <= 0) {
        throw new LaunchPricingError("The provider has not supplied valid resource dimensions.");
      }
      lines.push(
        hourlyLine("cpu", "CPU", resolved.profile.cpuCores, "vCPU-hour", rates.cpuCoreHourCents),
        hourlyLine("ram", "RAM", resolved.profile.ramGb, "GB-hour", rates.ramGbHourCents),
        hourlyLine("root", "Root disk", resolved.rootStorage.sizeGb, "GB-hour", rates.rootGbHourCents),
      );
    }
  }

  const instanceHourlyCents = lines.reduce((sum, line) => sum + line.hourlyCents, 0);
  if (!Number.isSafeInteger(instanceHourlyCents) || instanceHourlyCents > MAX_STORED_CENTS || (!monthly && instanceHourlyCents <= 0)) {
    throw new LaunchPricingError("This offering has no valid billable instance price.");
  }
  let sharedStorageHourlyCents = 0;
  if (resolved.sharedStorage) {
    const line = hourlyLine("shared", "Persistent shared storage", resolved.sharedStorage.sizeGb, "GB-hour", sharedStorageGbHourCents, true);
    sharedStorageHourlyCents = line.hourlyCents;
    lines.push(line);
  }
  const totalHourlyCents = Math.round((instanceHourlyCents + sharedStorageHourlyCents) * 1_000_000) / 1_000_000;
  if (!Number.isFinite(totalHourlyCents) || totalHourlyCents > MAX_STORED_CENTS) {
    throw new LaunchPricingError("This configuration exceeds the supported billing amount.");
  }
  return {
    version: 1,
    currency: "USD",
    basis: "per_instance",
    instanceHourlyCents,
    sharedStorageHourlyCents,
    totalHourlyCents,
    stoppedInstanceHourlyCents: instanceHourlyCents * stoppedRatePercent / 100,
    stoppedRatePercent,
    minimumBillingMinutes,
    prepayCents: Math.round(instanceHourlyCents * minimumBillingMinutes / 60),
    lines,
  };
}
