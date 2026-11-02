import { getStripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { deleteInstance, getPoolSubscriptions, getUnifiedInstanceDetail } from "@/lib/hostedai";
import type { PoolSubscription } from "@/lib/hostedai";
import { getPodGpuCount, getPodHourlyRateCents, getPodStoppedHourlyRateCents } from "@/lib/pod-billing";
import { getStoppedInstanceRatePercent } from "@/lib/pricing";

const BILLING_INTERVAL_MS = 30 * 60 * 1000;
const HAI_DEAD_STATUSES = ["error", "failed", "unknown"];

/** A refusal the caller can show as is: nothing was stopped, charged or forgotten. */
export class TerminationError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

export function isInstanceId(id: string): boolean {
  return /^i-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * True only when hosted.ai refuses the instance itself. For a deleted instance it answers 403 ("you
 * are not authorized"), seen on staging, rather than 404. Callers only ask after another call with
 * the same key worked, so a 403 here is about this instance, not a revoked key. Any other answer or
 * error is not proof.
 */
export async function isInstanceGone(instanceId: string): Promise<boolean> {
  try {
    await getUnifiedInstanceDetail(instanceId);
    return false;
  } catch (error) {
    return error instanceof Error && /\((403|404)\)/.test(error.message);
  }
}

/**
 * Deletes the GPU in hosted.ai. Resolves once hosted.ai accepted the delete, or the GPU is already
 * gone or dead; throws otherwise, so the caller keeps its billing record.
 */
export async function deleteGpu(instanceId: string): Promise<void> {
  try {
    await deleteInstance(instanceId);
  } catch (deleteErr) {
    if (await isInstanceGone(instanceId)) return;
    let status: string | null = null;
    try {
      status = (await getUnifiedInstanceDetail(instanceId))?.status?.toLowerCase() ?? null;
    } catch { /* not readable either way */ }
    if (status !== null && HAI_DEAD_STATUSES.includes(status)) {
      console.warn(`[Terminate] hosted.ai refused to delete ${instanceId} in state '${status}'; treating it as gone`);
      return;
    }
    throw deleteErr;
  }
}

/**
 * Takes over the GPU's billing before the final charge or credit. A billing run (/api/sync) that
 * is charging the same overdue time at this moment would otherwise be charged on top of it. If a
 * run got there first, the GPU is now paid ahead, and the paid time it saved is used instead,
 * so the unused part is credited back. Updates podMetadata in place.
 */
async function claimFinalSettlement(
  podMetadata: { id: string; prepaidUntil: Date | null; prepaidAmountCents: number | null },
  now: Date,
): Promise<Date> {
  const prepaidUntil = new Date(podMetadata.prepaidUntil!);
  if (now < prepaidUntil) return prepaidUntil;
  const claimed = await prisma.podMetadata.updateMany({
    where: { id: podMetadata.id, prepaidUntil: podMetadata.prepaidUntil },
    data: { prepaidUntil: now },
  });
  if (claimed.count > 0) return prepaidUntil;
  const current = await prisma.podMetadata.findUnique({
    where: { id: podMetadata.id },
    select: { prepaidUntil: true, prepaidAmountCents: true },
  });
  if (!current?.prepaidUntil) throw new Error("Billing changed during termination; try again");
  Object.assign(podMetadata, current);
  return current.prepaidUntil;
}

export interface TerminatedGpu {
  instanceId: string;
  displayName?: string;
  productId?: string | null;
  /** False when the GPU was deleted but its final credit or charge failed; the record is kept for review. */
  settled: boolean;
}

/**
 * The one way to end a GPU: customer Terminate, snapshot-and-terminate, admin Terminate and
 * monthly cancellation all come here. Order matters:
 *   1. read everything settlement needs (refuse here, and nothing has changed);
 *   2. delete the GPU in hosted.ai (if that fails, nothing has changed either);
 *   3. settle the hourly bill once, under the key settle_<record id>;
 *   4. forget our record.
 * Hourly GPUs settle against the account that paid for them (the record's stripeCustomerId).
 */
export async function terminateGpu(id: string, teamId: string): Promise<TerminatedGpu> {
  const podMetadata = await prisma.podMetadata.findFirst({
    where: { OR: [{ instanceId: id }, { subscriptionId: id }, { subscriptionId: `instance-${id}` }] },
  });
  const instanceId = isInstanceId(id) ? id : podMetadata?.instanceId;
  if (!instanceId) {
    throw new TerminationError("This GPU is on hosted.ai's retired pool system and can't be stopped here. Contact support.", 409, "LEGACY_POOL_GPU");
  }

  const configured = Boolean(podMetadata && (podMetadata.hourlyRateBasis === "per_instance" || podMetadata.launchConfiguration || podMetadata.rateSnapshot));
  const hourly = Boolean(podMetadata?.prepaidUntil && podMetadata.hourlyRateCents && podMetadata.billingType !== "monthly");
  if (configured && podMetadata?.billingType !== "monthly" && (!podMetadata?.prepaidUntil || getPodHourlyRateCents(podMetadata, 1) === null)) {
    throw new TerminationError("Captured billing data must be repaired before termination.", 409, "SETTLEMENT_REQUIRED");
  }

  // Overdue time is priced by what the GPU is doing now, so read that before it is deleted.
  // Refunds use the saved payment and must not depend on hosted.ai answering.
  const now = new Date();
  let subscription: PoolSubscription | undefined;
  if (hourly && (now >= podMetadata!.prepaidUntil! || !configured)) {
    try {
      subscription = (await getPoolSubscriptions(teamId)).find(sub => String(sub.id) === instanceId);
    } catch (error) {
      if (configured && now >= podMetadata!.prepaidUntil!) throw error;
      console.warn("[Billing] Provider status unavailable during prepaid refund:", error);
    }
    if (configured && now >= podMetadata!.prepaidUntil! && !subscription) {
      throw new Error("Instance status unavailable for final settlement");
    }
  }

  await deleteGpu(instanceId);

  let settled = true;
  if (hourly) {
    try {
      await settleFinalUsage(podMetadata!, subscription, now);
    } catch (error) {
      settled = false;
      console.error(`[Billing] GPU ${instanceId} was deleted but its final settlement failed; record kept for review:`, error);
    }
  }
  if (podMetadata && settled) {
    await prisma.podMetadata.delete({ where: { id: podMetadata.id } }).catch(() => {});
  }

  return { instanceId, displayName: podMetadata?.displayName || undefined, productId: podMetadata?.productId, settled };
}

type SettlementRecord = NonNullable<Awaited<ReturnType<typeof prisma.podMetadata.findFirst>>>;

/** Credits the unused part of the paid half hour, or charges the time since it ended. */
async function settleFinalUsage(podMetadata: SettlementRecord, subscription: PoolSubscription | undefined, now: Date) {
  const prepaidUntil = await claimFinalSettlement(podMetadata, now);
  const gpuCount = getPodGpuCount(podMetadata, subscription?.per_pod_info?.vgpu_count);
  const isStopped = Boolean(subscription?.pods?.length && subscription.pods.every(pod =>
    ["stopped", "paused", "reserved"].includes((pod.pod_status || "").toLowerCase())));
  // Stop does not reprice an already-paid running interval. Only overdue usage uses the current
  // reservation rate; unused credit returns what was paid.
  const hourlyRateCents = now >= prepaidUntil && isStopped && podMetadata.hourlyRateBasis === "per_instance"
    ? getPodStoppedHourlyRateCents(podMetadata, gpuCount, getStoppedInstanceRatePercent())
    : getPodHourlyRateCents(podMetadata, gpuCount);
  if (hourlyRateCents === null) throw new Error("Missing valid captured instance pricing");

  const stripe = await getStripe();
  const accountId = podMetadata.stripeCustomerId;
  const metadata = { instance_id: podMetadata.instanceId || podMetadata.subscriptionId };
  // One key per GPU, so a second terminate at the same moment can't settle again.
  const options = { idempotencyKey: `settle_${podMetadata.id}` };

  if (now < prepaidUntil) {
    const usedMs = now.getTime() - (prepaidUntil.getTime() - BILLING_INTERVAL_MS);
    const unusedMs = Math.min(BILLING_INTERVAL_MS, Math.max(0, BILLING_INTERVAL_MS - usedMs));
    const prepaidCents = podMetadata.prepaidAmountCents ?? hourlyRateCents * BILLING_INTERVAL_MS / 3_600_000;
    if (!Number.isFinite(prepaidCents) || prepaidCents < 0) throw new Error("Invalid saved prepayment");
    const creditBackCents = Math.round(prepaidCents * unusedMs / BILLING_INTERVAL_MS);
    if (creditBackCents > 0) {
      const unusedMins = Math.round(unusedMs / 60000);
      await stripe.customers.createBalanceTransaction(accountId, {
        amount: -creditBackCents,
        currency: "usd",
        description: `GPU early termination credit: ${unusedMins} mins unused`,
        metadata,
      }, options);
      console.log(`[Billing] Credited back $${(creditBackCents / 100).toFixed(2)} for early termination`);
    }
    return;
  }

  // Only charge more than a minute, to avoid micro-charges.
  const unbilledHours = (now.getTime() - prepaidUntil.getTime()) / 3_600_000;
  if (unbilledHours <= 1 / 60) return;
  const finalChargeCents = Math.round(unbilledHours * hourlyRateCents);
  if (finalChargeCents <= 0) return;
  const unbilledMins = Math.round(unbilledHours * 60);
  await stripe.customers.createBalanceTransaction(accountId, {
    amount: finalChargeCents,
    currency: "usd",
    description: `GPU final usage: ${unbilledMins} mins after prepaid period`,
    metadata,
  }, options);
  console.log(`[Billing] Charged $${(finalChargeCents / 100).toFixed(2)} for final unbilled usage`);
}
