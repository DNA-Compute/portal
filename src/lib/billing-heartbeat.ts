import { prisma } from "@/lib/prisma";

// Billing runs every 5 minutes inside the app. If it stops (crash, missing CRON_SECRET, a stuck
// run), nothing else notices and GPUs run unbilled, so each finished run is recorded here and
// /api/status/billing reports it for an outside uptime check.

const KEY = "billing_sync_last_run";
/** Six missed runs. Long enough to ride out one slow run, short enough to act the same hour. */
export const BILLING_STALE_AFTER_MS = 30 * 60_000;

interface BillingRun {
  finishedAt: string;
  podsErrors: number;
}

export async function recordBillingRun(podsErrors: number, now = new Date()): Promise<void> {
  const value = JSON.stringify({ finishedAt: now.toISOString(), podsErrors } satisfies BillingRun);
  await prisma.systemSetting.upsert({
    where: { key: KEY },
    update: { value, encrypted: false },
    create: { key: KEY, value, encrypted: false },
  });
}

export async function getBillingHealth(now = new Date()): Promise<{
  ok: boolean;
  reason?: "never_run" | "stale" | "pod_errors";
  lastRunAt: string | null;
  podsErrors: number | null;
}> {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY } });
  if (!row) return { ok: false, reason: "never_run", lastRunAt: null, podsErrors: null };
  const run = JSON.parse(row.value) as BillingRun;
  const health = { lastRunAt: run.finishedAt, podsErrors: run.podsErrors };
  if (now.getTime() - new Date(run.finishedAt).getTime() > BILLING_STALE_AFTER_MS) {
    return { ok: false, reason: "stale", ...health };
  }
  // A GPU that errors every run is never billed, so that also needs a person.
  if (run.podsErrors > 0) return { ok: false, reason: "pod_errors", ...health };
  return { ok: true, ...health };
}
