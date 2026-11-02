export interface PodRateInput {
  hourlyRateCents: number | null;
  hourlyRateBasis?: string | null;
  billingType?: string | null;
  rateSnapshot?: unknown;
  launchConfiguration?: unknown;
}

/**
 * Accounts that run hourly GPUs from a prepaid wallet: paid hourly, and free or free-trial accounts
 * spending drip or voucher credit. Billing charges, bills stopped GPUs for and shuts down all of them
 * alike; monthly accounts pay through their Stripe subscription instead.
 */
export const WALLET_BILLING_TYPES: readonly string[] = ["hourly", "free_trial", "free"];

export function usesWallet(billingType: string | null | undefined): boolean {
  return WALLET_BILLING_TYPES.includes(billingType || "");
}

function snapshotRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Saved whole-GPU quantities remain available when GPU VM responses omit pod_info. */
export function getPodGpuCount(pod: Pick<PodRateInput, "launchConfiguration">, providerCount?: number): number {
  const savedCount = snapshotRecord(pod.launchConfiguration)?.gpuCount;
  if (typeof savedCount === "number" && Number.isSafeInteger(savedCount) && savedCount > 0) return savedCount;
  return Math.max(1, Math.ceil(providerCount || 1));
}

/** Entire instance rate, excluding separately metered shared volumes. Null is unpriced. */
export function getPodHourlyRateCents(pod: PodRateInput, gpuCount: number): number | null {
  if (pod.billingType === "monthly") return null;
  if (!validRate(pod.hourlyRateCents)) return null;
  if (pod.hourlyRateBasis === "per_instance") {
    const snapshot = snapshotRecord(pod.rateSnapshot);
    if (snapshot?.version !== 1 || snapshot.basis !== "per_instance"
      || snapshot.instanceHourlyCents !== pod.hourlyRateCents) return null;
    return pod.hourlyRateCents;
  }
  // A configured allocation must never be reinterpreted as a legacy GPU-only rate.
  if (pod.launchConfiguration || pod.rateSnapshot) return null;
  if (pod.hourlyRateBasis && pod.hourlyRateBasis !== "per_gpu") return null;
  return pod.hourlyRateCents * Math.max(1, Math.ceil(gpuCount || 1));
}

/** Captured stopped prices survive later edits to the global percentage. */
export function getPodStoppedHourlyRateCents(
  pod: PodRateInput,
  gpuCount: number,
  stoppedRatePercent: number,
): number | null {
  const running = getPodHourlyRateCents(pod, gpuCount);
  if (running === null) return null;
  if (pod.hourlyRateBasis === "per_instance") {
    const snapshot = snapshotRecord(pod.rateSnapshot);
    if (validRate(snapshot?.stoppedInstanceHourlyCents)) return snapshot.stoppedInstanceHourlyCents;
    const percent = snapshot?.stoppedRatePercent;
    return validRate(percent) && percent <= 100 ? running * percent / 100 : null;
  }
  return running * stoppedRatePercent / 100;
}

/** Pool backfills are only safe for an unconfigured, historical hourly row. */
export function canBackfillPodRate(pod: PodRateInput): boolean {
  return pod.billingType !== "monthly"
    && (!pod.hourlyRateBasis || pod.hourlyRateBasis === "per_gpu")
    && !pod.launchConfiguration && !pod.rateSnapshot
    && !pod.hourlyRateCents;
}
