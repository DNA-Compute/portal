import { getStripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { deleteInstance, getPoolSubscriptions, getUnifiedInstanceDetail } from "@/lib/hostedai";
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

export interface TerminatedGpu {
  instanceId: string;
  displayName?: string;
  productId?: string | null;
  /** False when the GPU was deleted but crediting its unused time failed; logged for a manual credit. */
  settled: boolean;
}

/**
 * The one way to end a GPU: customer Terminate, snapshot-and-terminate, admin Terminate and
 * monthly cancellation all come here. Order matters:
 *   1. check everything settlement needs, and list the team's GPUs once (refuse here, and nothing
 *      has changed). The listing also proves the hosted.ai key works, so a 403 for this GPU later
 *      means the GPU is gone, not that the key is bad;
 *   2. charge overdue time. It was used whatever happens next, so it goes first, and a failed
 *      charge stops the termination with nothing changed;
 *   3. delete the GPU in hosted.ai;
 *   4. credit the unused part of the paid half hour, only now that the GPU is gone;
 *   5. forget our record.
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
  const hourly = podMetadata?.prepaidUntil && podMetadata.hourlyRateCents && podMetadata.billingType !== "monthly" ? podMetadata : null;
  const savedPayment = podMetadata?.prepaidAmountCents;
  if ((configured && podMetadata?.billingType !== "monthly" && (!podMetadata?.prepaidUntil || getPodHourlyRateCents(podMetadata, 1) === null))
    || (hourly && savedPayment != null && !(Number.isFinite(savedPayment) && savedPayment >= 0))) {
    throw new TerminationError("Captured billing data must be repaired before termination.", 409, "SETTLEMENT_REQUIRED");
  }

  const subscription = (await getPoolSubscriptions(teamId)).find(sub => String(sub.id) === instanceId);
  const now = new Date();
  let runningRateCents = 0;
  if (hourly) {
    const gpuCount = getPodGpuCount(hourly, subscription?.per_pod_info?.vgpu_count);
    const rate = getPodHourlyRateCents(hourly, gpuCount);
    if (rate === null) throw new Error("Missing valid captured instance pricing");
    runningRateCents = rate;
    if (now >= hourly.prepaidUntil!) {
      // Overdue time is priced by what the GPU is doing now.
      if (configured && !subscription) throw new Error("Instance status unavailable for final settlement");
      const isStopped = Boolean(subscription?.pods?.length && subscription.pods.every(pod =>
        ["stopped", "paused", "reserved"].includes((pod.pod_status || "").toLowerCase())));
      const overdueRateCents = isStopped && hourly.hourlyRateBasis === "per_instance"
        ? getPodStoppedHourlyRateCents(hourly, gpuCount, getStoppedInstanceRatePercent())
        : runningRateCents;
      if (overdueRateCents === null) throw new Error("Missing valid captured instance pricing");
      await chargeOverdue(hourly, overdueRateCents, now);
    }
  }

  await deleteGpu(instanceId);

  let settled = true;
  if (hourly) {
    try {
      await creditUnused(hourly, runningRateCents, now);
    } catch (error) {
      settled = false;
      console.error(`[Billing] GPU ${instanceId} was deleted but crediting its unused time to ${hourly.stripeCustomerId} failed; credit it by hand:`, error);
    }
  }
  if (podMetadata) {
    await prisma.podMetadata.delete({ where: { id: podMetadata.id } }).catch((error) => {
      // Billing forgets it on its own once it is due, as hosted.ai no longer has the GPU.
      console.error(`[Terminate] Could not forget the record of deleted GPU ${instanceId}:`, error);
    });
  }

  return { instanceId, displayName: podMetadata?.displayName || undefined, productId: podMetadata?.productId, settled };
}

type SettlementRecord = NonNullable<Awaited<ReturnType<typeof prisma.podMetadata.findFirst>>>;

// A settlement key names the paid-up time it settles, so Stripe refuses a repeat of the same
// settlement (it was done already), while a later, different one goes through.
function alreadySettled(error: unknown): boolean {
  return (error as { type?: string } | null)?.type === "StripeIdempotencyError";
}

/**
 * Charges the time since the paid half hour ended and marks the GPU paid up to now. It takes that
 * time over from the billing run first, so the run can't charge it too; if a run got there first,
 * the GPU is paid ahead instead and creditUnused settles it. A failed charge gives the time back.
 */
async function chargeOverdue(record: SettlementRecord, rateCents: number, now: Date) {
  const from = record.prepaidUntil!;
  const claimed = await prisma.podMetadata.updateMany({
    where: { id: record.id, prepaidUntil: from },
    data: { prepaidUntil: now, prepaidAmountCents: 0 },
  });
  if (claimed.count === 0) return;
  // Only charge more than a minute, to avoid micro-charges.
  const unbilledHours = (now.getTime() - from.getTime()) / 3_600_000;
  const amount = unbilledHours > 1 / 60 ? Math.round(unbilledHours * rateCents) : 0;
  if (amount <= 0) return;
  try {
    const stripe = await getStripe();
    await stripe.customers.createBalanceTransaction(record.stripeCustomerId, {
      amount,
      currency: "usd",
      description: `GPU final usage: ${Math.round(unbilledHours * 60)} mins after prepaid period`,
      metadata: { instance_id: record.instanceId || record.subscriptionId },
    }, { idempotencyKey: `settle_due_${record.id}_${from.getTime()}` });
    console.log(`[Billing] Charged $${(amount / 100).toFixed(2)} for final unbilled usage`);
  } catch (error) {
    if (alreadySettled(error)) return;
    await prisma.podMetadata.updateMany({
      where: { id: record.id, prepaidUntil: now },
      data: { prepaidUntil: from, prepaidAmountCents: record.prepaidAmountCents },
    });
    throw error;
  }
}

/** Credits back the unused part of the half hour the GPU is paid up to, as saved right now. */
async function creditUnused(record: SettlementRecord, runningRateCents: number, now: Date) {
  const current = await prisma.podMetadata.findUnique({
    where: { id: record.id },
    select: { prepaidUntil: true, prepaidAmountCents: true },
  });
  const paidUntil = current?.prepaidUntil;
  if (!paidUntil || now >= paidUntil) return;
  const usedMs = now.getTime() - (paidUntil.getTime() - BILLING_INTERVAL_MS);
  const unusedMs = Math.min(BILLING_INTERVAL_MS, Math.max(0, BILLING_INTERVAL_MS - usedMs));
  const prepaidCents = current.prepaidAmountCents ?? runningRateCents * BILLING_INTERVAL_MS / 3_600_000;
  const creditBackCents = Math.round(prepaidCents * unusedMs / BILLING_INTERVAL_MS);
  if (creditBackCents <= 0) return;
  try {
    const stripe = await getStripe();
    await stripe.customers.createBalanceTransaction(record.stripeCustomerId, {
      amount: -creditBackCents,
      currency: "usd",
      description: `GPU early termination credit: ${Math.round(unusedMs / 60000)} mins unused`,
      metadata: { instance_id: record.instanceId || record.subscriptionId },
    }, { idempotencyKey: `settle_credit_${record.id}_${paidUntil.getTime()}` });
    console.log(`[Billing] Credited back $${(creditBackCents / 100).toFixed(2)} for early termination`);
  } catch (error) {
    if (!alreadySettled(error)) throw error;
  }
}
