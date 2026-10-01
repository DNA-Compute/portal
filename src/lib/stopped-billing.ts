import { getPodHourlyRateCents, getPodStoppedHourlyRateCents, type PodRateInput } from "./pod-billing";

/** Stopped reservations use each allocation's own saved rate, never a fleet average. */
export interface StoppedPodInput extends PodRateInput {
  gpuCount: number;
}

export interface StoppedChargeResult {
  /** Total GPUs actually billed (priced pods only). Used for the charge description. */
  stoppedGpuCount: number;
  /** Amount to charge for this billing interval, in cents (rounded). */
  stoppedCostCents: number;
}

/** Sum each pod's reservation rate, then round once per billing interval. */
export function computeStoppedCharge(
  pods: StoppedPodInput[],
  stoppedRatePercent: number,
  intervalMinutes: number,
): StoppedChargeResult {
  const hoursInInterval = intervalMinutes / 60;

  let stoppedGpuCount = 0;
  let stoppedHourlyRateCents = 0;

  for (const pod of pods) {
    const runningRate = getPodHourlyRateCents(pod, pod.gpuCount);
    const stoppedRate = getPodStoppedHourlyRateCents(pod, pod.gpuCount, stoppedRatePercent);
    if (runningRate === null || runningRate <= 0 || stoppedRate === null) continue;
    stoppedGpuCount += Math.max(1, Math.ceil(pod.gpuCount || 1));
    stoppedHourlyRateCents += stoppedRate;
  }

  const stoppedCostCents = Math.round(
    stoppedHourlyRateCents * hoursInInterval,
  );

  return { stoppedGpuCount, stoppedCostCents };
}

/** Minimal shape of a Stripe customer balance transaction for the dedup check. */
export interface RecentBalanceTxn {
  created: number; // unix seconds
  metadata?: { billing_type?: string | null } | null;
}

export const STOPPED_RESERVATION_BILLING_TYPE = "stopped_reservation";

/**
 * Dedup guard: true if a stopped-reservation charge was already posted within
 * `withinSeconds` of `nowSec`.
 *
 * The running-charge path is idempotent per interval via each pod's prepaidUntil
 * (plus a recent-chargeId check). The stopped-charge path has no prepaidUntil, so
 * without this a double cron run could bill stopped pods twice — e.g. a brand-new
 * customer with no storage-sync timestamp yet, or two overlapping invocations
 * racing the 25-min storage-sync gate. A short window (well under the ~25-min
 * legitimate spacing) catches those races without blocking real consecutive bills.
 */
export function wasStoppedBilledRecently(
  txns: RecentBalanceTxn[],
  nowSec: number,
  withinSeconds: number,
): boolean {
  const cutoff = nowSec - withinSeconds;
  return txns.some(
    (t) => t.metadata?.billing_type === STOPPED_RESERVATION_BILLING_TYPE && t.created > cutoff,
  );
}
