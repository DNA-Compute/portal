import { prisma } from "@/lib/prisma";
import { getAllUnifiedInstances } from "@/lib/hostedai/instances";

// Billing runs every 5 minutes inside the app. If it stops (crash, missing CRON_SECRET, a stuck
// run), nothing else notices and GPUs run unbilled, so each finished run is recorded here and
// /api/status/billing reports it for an outside uptime check.

const KEY = "billing_sync_last_run";
/** Six missed runs. Long enough to ride out one slow run, short enough to act the same hour. */
export const BILLING_STALE_AFTER_MS = 30 * 60_000;
/** A billed GPU is normally paid up into the future, so an hour in the past means billing is not keeping up. */
export const BILLING_BEHIND_AFTER_MS = 60 * 60_000;
/** Time a launch has to save its billing record after hosted.ai creates the instance. */
const NEW_INSTANCE_GRACE_MS = 15 * 60_000;

interface BillingRun {
  finishedAt: string;
  podsErrors: number;
  /** hosted.ai instances with no billing record; null when hosted.ai could not be asked. */
  untrackedGpus?: number | null;
}

export async function recordBillingRun(
  run: { podsErrors: number; untrackedGpus: number | null },
  now = new Date()
): Promise<void> {
  const value = JSON.stringify({ finishedAt: now.toISOString(), ...run } satisfies BillingRun);
  await prisma.systemSetting.upsert({
    where: { key: KEY },
    update: { value, encrypted: false },
    create: { key: KEY, value, encrypted: false },
  });
}

/**
 * hosted.ai instances the portal has no billing record for, such as a GPU started from hosted.ai's
 * own panel. Nobody is charged for them. Returns null when hosted.ai cannot be reached, because then
 * GPUs can be neither billed nor stopped.
 */
export async function countUntrackedGpus(now = new Date()): Promise<number | null> {
  let instances;
  try {
    instances = await getAllUnifiedInstances();
  } catch (error) {
    console.error("[Billing health] Could not list hosted.ai instances:", error);
    return null;
  }
  const records = await prisma.podMetadata.findMany({ select: { subscriptionId: true, instanceId: true } });
  const known = new Set<string>();
  for (const r of records) {
    known.add(r.subscriptionId.replace(/^instance-/, ""));
    if (r.instanceId) known.add(r.instanceId);
  }
  const untracked = instances.filter(i =>
    !known.has(String(i.id)) && now.getTime() - new Date(i.created_at).getTime() > NEW_INSTANCE_GRACE_MS
  );
  for (const i of untracked) {
    console.error(`[Billing health] hosted.ai instance ${i.id} (${i.status}, created ${i.created_at}) has no billing record`);
  }
  return untracked.length;
}

export async function getBillingHealth(now = new Date()): Promise<{
  ok: boolean;
  reason?: "never_run" | "stale" | "pod_errors" | "hosted_ai_unreachable" | "untracked_gpus" | "billing_behind";
  lastRunAt: string | null;
  podsErrors: number | null;
  untrackedGpus?: number | null;
  gpusBehind?: number;
}> {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY } });
  if (!row) return { ok: false, reason: "never_run", lastRunAt: null, podsErrors: null };
  const run = JSON.parse(row.value) as BillingRun;
  // Hourly GPUs whose paid-up time is long past: whatever the cause, they run without being paid for.
  const gpusBehind = await prisma.podMetadata.count({
    where: {
      prepaidUntil: { lt: new Date(now.getTime() - BILLING_BEHIND_AFTER_MS) },
      hourlyRateCents: { gt: 0 },
      OR: [{ billingType: null }, { billingType: { not: "monthly" } }],
    },
  });
  const health = { lastRunAt: run.finishedAt, podsErrors: run.podsErrors, untrackedGpus: run.untrackedGpus, gpusBehind };
  if (now.getTime() - new Date(run.finishedAt).getTime() > BILLING_STALE_AFTER_MS) {
    return { ok: false, reason: "stale", ...health };
  }
  // A GPU that errors every run is never billed, so that also needs a person.
  if (run.podsErrors > 0) return { ok: false, reason: "pod_errors", ...health };
  if (run.untrackedGpus === null) return { ok: false, reason: "hosted_ai_unreachable", ...health };
  if ((run.untrackedGpus ?? 0) > 0) return { ok: false, reason: "untracked_gpus", ...health };
  if (gpusBehind > 0) return { ok: false, reason: "billing_behind", ...health };
  return { ok: true, ...health };
}
