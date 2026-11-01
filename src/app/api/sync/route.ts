import { NextRequest, NextResponse } from "next/server";
import { recordBillingRun } from "@/lib/billing-heartbeat";
import { getStripe } from "@/lib/stripe";
import { getSharedVolumes, getPoolSubscriptions, type SharedVolume } from "@/lib/hostedai";
import { checkAndRefillWallet, WALLET_CONFIG } from "@/lib/wallet";
import { getStoragePricePerGBHourCents, getStoppedInstanceRatePercent } from "@/lib/pricing";
import { computeStorageCharge } from "@/lib/storage-billing";
import { computeStoppedCharge, wasStoppedBilledRecently, type StoppedPodInput } from "@/lib/stopped-billing";
import { getProductByPoolId } from "@/lib/products";
import { canBackfillPodRate, getPodGpuCount, getPodHourlyRateCents, getPodStoppedHourlyRateCents } from "@/lib/pod-billing";
import { prisma } from "@/lib/prisma";
import { sendNegativeBalanceShutdownEmail } from "@/lib/email";
import { cacheCustomer } from "@/lib/customer-cache";
import { readPoolOverviewCache } from "@/lib/pool-overview";
import { verifyCronAuth } from "@/lib/cron-auth";
import type Stripe from "stripe";
import crypto from "crypto";

// Secret key to protect the sync endpoint (set in env)
const SYNC_SECRET = process.env.SYNC_SECRET;

// The in-process scheduler calls this with CRON_SECRET, like every other scheduled job. SYNC_SECRET
// still works for an external cron. Packet OSS ships neither the cron file nor SYNC_SECRET, so
// without the scheduler GPUs were charged their first 30 minutes and never again.
// Header only: a ?secret= query string ends up in proxy and access logs.
function authorizeSync(request: NextRequest): NextResponse | null {
  if (request.nextUrl.searchParams.has("secret")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (SYNC_SECRET && secretsMatch(request.headers.get("authorization"), `Bearer ${SYNC_SECRET}`)) return null;
  return verifyCronAuth(request);
}

function secretsMatch(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Track when reconciliation last ran (Step 0) — only needs to run once per hour
let lastReconciliationRun = 0;
const RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

// A wallet this far below zero is left running: one late block or rounding must not end a GPU.
const NEGATIVE_BALANCE_GRACE_CENTS = 100;

// GPU time unbilled for longer than this (6 hours) is held for manual settlement, not charged.
const MAX_AUTO_CATCHUP_BLOCKS = 12;

// Longest gap storage and stopped GPUs are metered for in one go.
const MAX_METERED_MINUTES = 24 * 60;

// Billing interval in minutes (each pod is billed every 30 mins from its deploy time)
const BILLING_INTERVAL_MINUTES = 30;
const BILLING_INTERVAL_MS = BILLING_INTERVAL_MINUTES * 60 * 1000;

interface PodBillingResult {
  subscriptionId: string;
  customerId: string;
  email?: string;
  status: "billed" | "not_due" | "error" | "skipped_stopped";
  amountCents?: number;
  nextBillingAt?: Date;
  error?: string;
}

export async function POST(request: NextRequest) {
  const authError = authorizeSync(request);
  if (authError) return authError;

  const stripe = await getStripe();
  const now = new Date();
  const podResults: PodBillingResult[] = [];
  const heldBacklogs: Array<{ subscriptionId: string; customerId: string; from: Date; to: Date; minutes: number; estimatedCents: number }> = [];
  const customerRefills: Map<string, Awaited<ReturnType<typeof checkAndRefillWallet>>> = new Map();

  // Get stopped instance rate configuration
  const stoppedInstanceRatePercent = getStoppedInstanceRatePercent();
  const storagePriceCentsPerGBHour = getStoragePricePerGBHourCents();

  // === PER-RUN CACHES ===
  // Avoid calling hosted.ai multiple times for the same team within a single sync run.
  // Each getPoolSubscriptions call takes ~1-2s and hits the hosted.ai API.
  const subsCache = new Map<string, Awaited<ReturnType<typeof getPoolSubscriptions>>>();
  const volumeCache = new Map<string, Awaited<ReturnType<typeof getSharedVolumes>>>();

  async function getCachedSubs(teamId: string) {
    const cached = subsCache.get(teamId);
    if (cached) return cached;
    const result = await getPoolSubscriptions(teamId);
    subsCache.set(teamId, result);
    return result;
  }

  async function getCachedVolumes(teamId: string) {
    const cached = volumeCache.get(teamId);
    if (cached) return cached;
    const result = await getSharedVolumes(teamId);
    volumeCache.set(teamId, result);
    return result;
  }

  try {
    // === STEP 0: BILLING RECONCILIATION ===
    // Only runs once per hour (not every sync cycle) to reduce hosted.ai API load.
    // Uses pool overview cache (local file) to detect orphaned subs without API calls.
    const reconciliationResults: Array<{
      customerId: string;
      subscriptionId: string;
      poolId: string;
      hourlyRateCents: number;
      action: string;
    }> = [];

    // DNA patch: off unless BILLING_RECONCILIATION_ENABLED=true. It switches a team owner to hourly
    // billing before checking anything is billable, and reads a pool cache nothing on DNA refreshes.
    // Every GPU launched through the portal already has the PodMetadata row STEP 1 bills from.
    const reconciliationEnabled = process.env.BILLING_RECONCILIATION_ENABLED === "true";
    const shouldReconcile = reconciliationEnabled && Date.now() - lastReconciliationRun >= RECONCILIATION_INTERVAL_MS;

    if (shouldReconcile) {
      lastReconciliationRun = Date.now();

      try {
        // Use pool overview cache to find all active pods (no hosted.ai API calls)
        const poolCache = readPoolOverviewCache();
        if (poolCache?.pools) {
          // Build map: teamId → list of active sub-like objects from the cache
          const activeTeamPods = new Map<string, Array<{ poolId: number; poolName: string; status: string }>>();
          for (const pool of poolCache.pools) {
            for (const pod of pool.pods || []) {
              if (pod.teamId && ["subscribed", "active", "running"].includes(pod.status)) {
                const arr = activeTeamPods.get(pod.teamId) || [];
                arr.push({ poolId: pool.id, poolName: pool.name, status: pod.status });
                activeTeamPods.set(pod.teamId, arr);
              }
            }
          }

          // Cross-check: for each team with active pods, check if all their subs have PodMetadata
          // Only call hosted.ai for teams that actually have gaps
          for (const [teamId, pods] of activeTeamPods) {
            // Find the customer for this team from our local DB
            // Include "free" customers — they may have active pods via voucher credit
            const customerCache = await prisma.customerCache.findFirst({
              where: { teamId, isDeleted: false },
            });
            if (!customerCache) continue;

            // Pull the HAI subs FIRST so we know which sub IDs to look up locally.
            // (Reordered from the previous flow so the global existence check below
            // has the canonical list of HAI sub IDs to query against.)
            let activeSubs: Awaited<ReturnType<typeof getPoolSubscriptions>>;
            try {
              activeSubs = await getCachedSubs(teamId);
            } catch (subErr) {
              console.error(`[Sync Reconcile] Error fetching subs for team ${teamId}:`, subErr);
              continue;
            }

            const activeSubIds = activeSubs
              .filter(s => s.status === "subscribed" || s.status === "active")
              .map(s => String(s.id));

            if (activeSubIds.length === 0) continue;

            // Existence check is GLOBAL across all customers. instance_id and
            // subscription_id are unique, so a HAI sub can only be claimed by one
            // row — but the claiming row may be owned by a different Stripe
            // customer (third-party payer for someone else's team). Scoping this
            // query to customerCache.id (the team owner) hid those rows and made
            // reconciliation create rogue hourly duplicates that silently flipped
            // monthly pods to hourly billing. See PA-209 / sync-reconciliation-
            // duplicate-rows memory.
            const existingMeta = await prisma.podMetadata.findMany({
              where: {
                OR: [
                  { subscriptionId: { in: activeSubIds } },
                  { subscriptionId: { in: activeSubIds.map(id => `instance-${id}`) } },
                  { instanceId: { in: activeSubIds } },
                ],
              },
              select: {
                subscriptionId: true,
                instanceId: true,
                stripeCustomerId: true,
                hourlyRateCents: true,
                billingType: true,
                hourlyRateBasis: true,
                rateSnapshot: true,
                launchConfiguration: true,
                productId: true,
              },
            });

            // Map every variant of a sub's storage shape back to the canonical
            // bare HAI sub id, so we can answer "does any row claim this sub?".
            const claimedSubIds = new Set<string>();
            for (const m of existingMeta) {
              if (m.instanceId) claimedSubIds.add(m.instanceId);
              if (m.subscriptionId.startsWith("instance-")) {
                claimedSubIds.add(m.subscriptionId.slice("instance-".length));
              } else {
                claimedSubIds.add(m.subscriptionId);
              }
            }

            // Force-flip the team owner's billing_type to "hourly" only if no row
            // for this team is explicitly monthly. Third-party-payer setups want
            // the team owner to stay on whatever they were (free/monthly) while
            // the actual billing happens via the payer's Stripe subscription.
            const hasMonthlyMetaForTeam = existingMeta.some(m => m.billingType === "monthly");
            if (customerCache.billingType !== "hourly" && !hasMonthlyMetaForTeam) {
              try {
                await stripe.customers.update(customerCache.id, {
                  metadata: { billing_type: "hourly" },
                });
                await prisma.customerCache.update({
                  where: { id: customerCache.id },
                  data: { billingType: "hourly" },
                });
                console.log(`[Sync Reconcile] Upgraded ${customerCache.id} (${customerCache.email}) billing_type from "${customerCache.billingType}" to "hourly" — has ${pods.length} active pod(s)`);
              } catch (upgradeErr) {
                console.error(`[Sync Reconcile] Failed to upgrade billing_type for ${customerCache.id}:`, upgradeErr);
              }
            }

            for (const sub of activeSubs) {
              if (sub.status !== "subscribed" && sub.status !== "active") continue;
              const subId = String(sub.id);

              if (claimedSubIds.has(subId)) {
                // Some row already claims this HAI sub. Only backfill a missing
                // rate if the row belongs to the team owner AND is explicitly
                // hourly (or unset, which we treat as hourly). Never touch a
                // monthly row or a row owned by a different customer.
                const own = existingMeta.find(m =>
                  (m.instanceId === subId
                    || m.subscriptionId === subId
                    || m.subscriptionId === `instance-${subId}`)
                  && m.stripeCustomerId === customerCache.id
                  && canBackfillPodRate(m)
                );
                if (own) {
                  const product = await getProductByPoolId(sub.pool_id, own.productId);
                  const rateCents = product?.hourly_rate_cents || 0;
                  if (rateCents > 0) {
                    const fullExisting = await prisma.podMetadata.findUnique({ where: { subscriptionId: own.subscriptionId } });
                    await prisma.podMetadata.update({
                      where: { subscriptionId: own.subscriptionId },
                      data: {
                        hourlyRateCents: rateCents,
                        poolId: fullExisting?.poolId || String(sub.pool_id),
                        productId: fullExisting?.productId || product?.id || null,
                        ...(fullExisting?.prepaidUntil ? {} : { prepaidUntil: now }),
                      },
                    });
                    console.log(`[Sync Reconcile] Updated PodMetadata for sub ${subId} - set rate to $${(rateCents / 100).toFixed(2)}/hr`);
                    reconciliationResults.push({
                      customerId: customerCache.id,
                      subscriptionId: own.subscriptionId,
                      poolId: String(sub.pool_id),
                      hourlyRateCents: rateCents,
                      action: "updated",
                    });
                  }
                }
                continue;
              }

              // Truly orphaned — no pod_metadata row exists anywhere for this HAI
              // sub. Create one under the team owner with the hourly product rate.
              const product = await getProductByPoolId(sub.pool_id);
              const rateCents = product?.hourly_rate_cents || 0;
              if (rateCents === 0) continue;

              await prisma.podMetadata.create({
                data: {
                  subscriptionId: subId,
                  stripeCustomerId: customerCache.id,
                  displayName: sub.pool_name || null,
                  hourlyRateCents: rateCents,
                  poolId: String(sub.pool_id),
                  productId: product?.id || null,
                  prepaidUntil: now,
                },
              });
              console.log(`[Sync Reconcile] Created PodMetadata for orphaned sub ${subId} @ $${(rateCents / 100).toFixed(2)}/hr`);
              reconciliationResults.push({
                customerId: customerCache.id,
                subscriptionId: subId,
                poolId: String(sub.pool_id),
                hourlyRateCents: rateCents,
                action: "created",
              });
            }
          }
        }

        if (reconciliationResults.length > 0) {
          console.log(`[Sync Reconcile] Fixed ${reconciliationResults.length} orphaned subscription(s)`);
        }
      } catch (reconcileErr) {
        console.error("[Sync Reconcile] Error during reconciliation:", reconcileErr);
      }
    } else if (reconciliationEnabled) {
      console.log(`[Sync] Skipping reconciliation (last ran ${Math.round((Date.now() - lastReconciliationRun) / 60000)}m ago, interval=${RECONCILIATION_INTERVAL_MS / 60000}m)`);
    }

    // === STEP 1: PER-POD BILLING ===
    // Find all pods where prepaidUntil <= now (their billing is due)
    // Also include pods where prepaidUntil is null (never billed after initial deployment)
    const podsDue = await prisma.podMetadata.findMany({
      where: {
        OR: [
          { prepaidUntil: { lte: now } },
          { prepaidUntil: null }, // Pods that were never properly initialized for billing
        ],
        hourlyRateCents: { gt: 0 }, // Must have a rate configured
        AND: [{ OR: [{ billingType: null }, { billingType: { not: "monthly" } }] }],
      },
    });

    console.log(`[Sync] Found ${podsDue.length} pods due for billing`);

    // Build product -> poolId lookup for HAI 2.2 pods that have no poolId
    const productPoolMap = new Map<string, number>();
    const podsNeedPoolId = podsDue.some(p => !p.poolId && p.productId);
    if (podsNeedPoolId) {
      const products = await prisma.gpuProduct.findMany({
        where: { active: true },
        select: { id: true, poolIds: true },
      });
      for (const p of products) {
        try {
          const pids: number[] = JSON.parse(p.poolIds);
          if (pids.length > 0) productPoolMap.set(p.id, pids[0]);
        } catch { /* skip malformed */ }
      }
    }

    for (const pod of podsDue) {
      try {
        // Get customer email for logging
        let customerEmail = "unknown";
        try {
          const customer = await stripe.customers.retrieve(pod.stripeCustomerId) as Stripe.Customer;
          cacheCustomer(customer).catch(() => {});
          customerEmail = customer.email || "unknown";
        } catch {
          // Continue without email
        }

        // Verify the subscription is still active
        const teamId = await getTeamIdForCustomer(stripe, pod.stripeCustomerId);
        if (!teamId) {
          console.log(`[Sync] Skipping pod ${pod.subscriptionId}: no team ID for customer`);
          podResults.push({
            subscriptionId: pod.subscriptionId,
            customerId: pod.stripeCustomerId,
            email: customerEmail,
            status: "error",
            error: "No team ID for customer",
          });
          continue;
        }

        // Check if subscription still exists and is active (uses per-run cache)
        const subscriptions = await getCachedSubs(teamId);
        // Match by instanceId first (HAI 2.2), fall back to subscriptionId (legacy)
        const subscription = pod.instanceId
          ? subscriptions.find(s => s.id === pod.instanceId)
          : subscriptions.find(s => String(s.id) === pod.subscriptionId);

        if (!subscription || (subscription.status !== "subscribed" && subscription.status !== "active")) {
          console.log(`[Sync] Skipping pod ${pod.subscriptionId}: subscription not active (status: ${subscription?.status || "not found"})`);
          // SAFETY: Never delete pod_metadata — just skip billing
          podResults.push({
            subscriptionId: pod.subscriptionId,
            customerId: pod.stripeCustomerId,
            email: customerEmail,
            status: "error",
            error: `Subscription not active: ${subscription?.status || "not found"}`,
          });
          continue;
        }

        // Configured allocations prepay running or stopped coverage on this same cursor.
        // Ref: Confluence HP/600178689 — billable-at-full-rate statuses
        const FULL_RATE_STATUSES = ["running", "active", "restarting", "stopping", "resizing", "succeeded"];
        const podStatuses = (subscription.pods || []).map((p: { pod_status?: string }) => (p.pod_status || "").toLowerCase());
        const hasRunningPod = podStatuses.some((s: string) => FULL_RATE_STATUSES.includes(s));
        const configured = pod.hourlyRateBasis === "per_instance";
        const isStopped = !hasRunningPod && podStatuses.some(status => ["stopped", "paused", "reserved"].includes(status));
        // Every 30-minute block from the GPU's paid-up time to now is due. Normally that is one
        // block; after downtime, or on DNA where nothing ran billing until 2026-10, it is the whole
        // backlog, charged as one line rather than one block per run.
        // A GPU with no paid-up time starts its first block now, saved once so the charge key is stable.
        let cursor = pod.prepaidUntil;
        if (!cursor) {
          const started = await prisma.podMetadata.updateMany({
            where: { subscriptionId: pod.subscriptionId, prepaidUntil: null },
            data: { prepaidUntil: now },
          });
          if (started.count === 0) {
            podResults.push({ subscriptionId: pod.subscriptionId, customerId: pod.stripeCustomerId, status: "not_due" });
            continue;
          }
          cursor = now;
        }
        let blocks = Math.floor((now.getTime() - cursor.getTime()) / BILLING_INTERVAL_MS) + 1;
        let nextBillingAt = new Date(cursor.getTime() + blocks * BILLING_INTERVAL_MS);
        let billingMinutes = blocks * BILLING_INTERVAL_MINUTES;

        // Moves the paid-up time only if no other run (or a termination) moved it first.
        const claim = (data: { prepaidAmountCents?: number }) => prisma.podMetadata.updateMany({
          where: { subscriptionId: pod.subscriptionId, prepaidUntil: cursor },
          data: { prepaidUntil: nextBillingAt, ...data },
        });

        if (!hasRunningPod && podStatuses.length > 0 && !configured) {
          console.log(`[Sync] Skipping pod ${pod.subscriptionId}: no running pods (statuses: ${podStatuses.join(", ")}). Will be billed at stopped rate.`);
          // Still advance prepaidUntil so we don't re-check every cycle. Nothing was paid for these
          // blocks, so early termination must not credit any back.
          await claim({ prepaidAmountCents: 0 });
          podResults.push({
            subscriptionId: pod.subscriptionId,
            customerId: pod.stripeCustomerId,
            email: customerEmail,
            status: "skipped_stopped",
            amountCents: 0,
          });
          continue;
        }

        // Calculate GPU count from subscription (round up, minimum 1 — no fractional GPU billing)
        const gpuCount = getPodGpuCount(pod, subscription.per_pod_info?.vgpu_count);

        // Calculate cost for 30 minutes
        const hoursToCharge = BILLING_INTERVAL_MINUTES / 60; // 0.5 hours
        const instanceHourlyRateCents = configured && isStopped
          ? getPodStoppedHourlyRateCents(pod, gpuCount, stoppedInstanceRatePercent)
          : getPodHourlyRateCents(pod, gpuCount);
        if (instanceHourlyRateCents === null) {
          podResults.push({ subscriptionId: pod.subscriptionId, customerId: pod.stripeCustomerId, status: "error", error: "Missing valid captured instance pricing" });
          continue;
        }
        const blockCents = Math.round(hoursToCharge * instanceHourlyRateCents);
        let amountCents = blocks * blockCents;
        if (amountCents === 0) {
          await claim({ prepaidAmountCents: 0 });
          podResults.push({ subscriptionId: pod.subscriptionId, customerId: pod.stripeCustomerId, status: "billed", amountCents: 0, nextBillingAt });
          continue;
        }

        // A long backlog is not charged automatically: it would be priced at the GPU's state today,
        // whatever it was doing then. It is recorded for someone to settle by hand, and billing
        // carries on from the current block.
        if (blocks > MAX_AUTO_CATCHUP_BLOCKS) {
          const heldFrom = cursor;
          const heldUntil = new Date(cursor.getTime() + (blocks - 1) * BILLING_INTERVAL_MS);
          const heldMinutes = (blocks - 1) * BILLING_INTERVAL_MINUTES;
          const held = await prisma.podMetadata.updateMany({
            where: { subscriptionId: pod.subscriptionId, prepaidUntil: heldFrom },
            data: { prepaidUntil: heldUntil },
          });
          if (held.count === 0) {
            podResults.push({ subscriptionId: pod.subscriptionId, customerId: pod.stripeCustomerId, status: "not_due" });
            continue;
          }
          const estimatedCents = (blocks - 1) * blockCents;
          console.error(`[Sync] HELD for manual settlement: pod ${pod.subscriptionId} was unbilled for ${heldMinutes} mins (${heldFrom.toISOString()} to ${heldUntil.toISOString()}), about $${(estimatedCents / 100).toFixed(2)} at today's rate`);
          await prisma.walletTransaction.create({
            data: {
              stripeCustomerId: pod.stripeCustomerId,
              teamId,
              type: "held_backlog",
              amountCents: 0,
              description: `Unbilled GPU time held for manual settlement: ${heldMinutes} mins`,
              subscriptionId: pod.subscriptionId,
              gpuCount,
              hourlyRateCents: pod.hourlyRateCents!,
              billingMinutes: heldMinutes,
              metadata: JSON.stringify({ from: heldFrom.toISOString(), to: heldUntil.toISOString(), estimatedCents, instanceHourlyRateCents, isStopped }),
            },
          }).catch((e) => console.error(`[Sync] Failed to record held backlog for pod ${pod.subscriptionId}:`, e));
          heldBacklogs.push({ subscriptionId: pod.subscriptionId, customerId: pod.stripeCustomerId, from: heldFrom, to: heldUntil, minutes: heldMinutes, estimatedCents });
          cursor = heldUntil;
          blocks = 1;
          nextBillingAt = new Date(cursor.getTime() + BILLING_INTERVAL_MS);
          billingMinutes = BILLING_INTERVAL_MINUTES;
          amountCents = blockCents;
        }

        // One key per GPU and paid-up time: a retry of the same blocks can never charge twice.
        const chargeId = `pod_${pod.subscriptionId}_${Math.floor(cursor.getTime() / 1000)}`;

        // Claim the blocks before charging, so overlapping runs and terminations cannot both charge
        // them. If the process dies after the claim and before the charge, they go unbilled.
        // prepaidAmountCents is what the current block cost, for the early-termination credit.
        const claimed = await claim({ prepaidAmountCents: blockCents });
        if (claimed.count === 0) {
          console.log(`[Sync] Skipping pod ${pod.subscriptionId}: already billed by another run`);
          podResults.push({ subscriptionId: pod.subscriptionId, customerId: pod.stripeCustomerId, email: customerEmail, status: "not_due" });
          continue;
        }

        const chargeDescription = `${isStopped ? "Reserved GPU" : "GPU usage"}: ${gpuCount} GPU(s) x ${billingMinutes} mins @ $${(instanceHourlyRateCents / 100).toFixed(2)}/instance/hr`;
        try {
          // An earlier attempt whose reply was lost may already have charged from this paid-up time,
          // possibly for fewer blocks. Stripe forgets idempotency keys after about a day, so look for
          // the charge itself, and pay up exactly the minutes it covered.
          const recentTxns = await stripe.customers.listBalanceTransactions(pod.stripeCustomerId, { limit: 100 });
          const landed = recentTxns.data.find(txn => txn.metadata?.pod_billing_id === chargeId);
          if (landed) {
            const landedMinutes = parseInt(landed.metadata?.billing_minutes ?? "", 10) || BILLING_INTERVAL_MINUTES;
            const paidUntil = new Date(cursor.getTime() + landedMinutes * 60_000);
            await prisma.podMetadata.updateMany({
              where: { subscriptionId: pod.subscriptionId, prepaidUntil: nextBillingAt },
              data: { prepaidUntil: paidUntil },
            });
            console.log(`[Sync] Pod ${pod.subscriptionId} was already charged ${landedMinutes} mins from ${cursor.toISOString()}; prepaid until ${paidUntil.toISOString()}`);
            podResults.push({ subscriptionId: pod.subscriptionId, customerId: pod.stripeCustomerId, email: customerEmail, status: "billed", amountCents: 0, nextBillingAt: paidUntil });
            continue;
          }

          await stripe.customers.createBalanceTransaction(pod.stripeCustomerId, {
            amount: amountCents,
            currency: "usd",
            description: chargeDescription,
            metadata: {
              subscription_id: pod.subscriptionId,
              gpu_count: gpuCount.toString(),
              hourly_rate_cents: pod.hourlyRateCents!.toString(),
              hourly_rate_basis: pod.hourlyRateBasis || "per_gpu",
              billing_type: isStopped ? "configured_stopped_reservation" : "gpu_usage",
              billing_minutes: billingMinutes.toString(),
              pod_billing_id: chargeId,
            },
          }, { idempotencyKey: chargeId });
        } catch (chargeErr) {
          // Release the blocks, whether the lookup or the charge failed. If the charge did land,
          // the next run finds it.
          await prisma.podMetadata.updateMany({
            where: { subscriptionId: pod.subscriptionId, prepaidUntil: nextBillingAt },
            data: { prepaidUntil: cursor, prepaidAmountCents: pod.prepaidAmountCents },
          });
          throw chargeErr;
        }

        // Resolve poolId: prefer pod.poolId, fall back to product's poolIds[0]
        let resolvedPoolId: number | null = pod.poolId ? parseInt(pod.poolId, 10) || null : null;
        if (resolvedPoolId === null && pod.productId) {
          resolvedPoolId = productPoolMap.get(pod.productId) ?? null;
          // Backfill PodMetadata so future cycles don't need the lookup
          if (resolvedPoolId !== null) {
            prisma.podMetadata.update({
              where: { subscriptionId: pod.subscriptionId },
              data: { poolId: String(resolvedPoolId) },
            }).catch(e => console.error(`[Sync] Failed to backfill poolId for ${pod.subscriptionId}:`, e));
          }
        }

        // Log to local WalletTransaction table
        await prisma.walletTransaction.create({
          data: {
            stripeCustomerId: pod.stripeCustomerId,
            teamId,
            type: isStopped ? "stopped_reservation" : "gpu_usage",
            amountCents,
            description: chargeDescription,
            subscriptionId: pod.subscriptionId,
            poolId: resolvedPoolId,
            gpuCount,
            hourlyRateCents: pod.hourlyRateCents!,
            billingMinutes,
            syncCycleId: chargeId,
          },
        }).catch((e) => console.error(`[Sync] Failed to log WalletTransaction for pod ${pod.subscriptionId}:`, e));

        console.log(`[Sync] Billed pod ${pod.subscriptionId}: $${(amountCents / 100).toFixed(2)} for ${gpuCount} GPU(s) x ${billingMinutes} mins. Was prepaid until ${cursor.toISOString()}, now prepaid until ${nextBillingAt.toISOString()}`);

        podResults.push({
          subscriptionId: pod.subscriptionId,
          customerId: pod.stripeCustomerId,
          email: customerEmail,
          status: "billed",
          amountCents,
          nextBillingAt,
        });
      } catch (error) {
        console.error(`[Sync] Error billing pod ${pod.subscriptionId}:`, error);
        podResults.push({
          subscriptionId: pod.subscriptionId,
          customerId: pod.stripeCustomerId,
          status: "error",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    // === STEP 2: STORAGE BILLING ===
    // Storage is still billed per-customer at fixed intervals (every 30 mins)
    // Get unique customers from pods we processed
    const customersToProcess = new Set(podResults.map(r => r.customerId));

    // Also add customers with active pods that weren't due
    const allActivePods = await prisma.podMetadata.findMany({
      where: { hourlyRateCents: { gt: 0 } },
      select: { stripeCustomerId: true },
    });
    allActivePods.forEach(p => customersToProcess.add(p.stripeCustomerId));

    // Persistent storage outlives PodMetadata and is chargeable on monthly accounts too.
    // The cache is maintained from Stripe interactions and its existing full-sync cron.
    const storageCandidates = await prisma.customerCache.findMany({
      where: {
        isDeleted: false,
        OR: [{ teamId: { not: null } }, { metadataJson: { contains: "primary_stripe_customer_id" } }],
      },
      select: { id: true },
    });
    storageCandidates.forEach(customer => customersToProcess.add(customer.id));

    const billingCustomers = new Map<string, Stripe.Customer>();
    const storageAccounts = new Map<string, { customer: Stripe.Customer; teamIds: Set<string> }>();
    for (const candidateId of customersToProcess) {
      try {
        let source = billingCustomers.get(candidateId);
        if (!source) {
          const retrieved = await stripe.customers.retrieve(candidateId);
          if ("deleted" in retrieved && retrieved.deleted) continue;
          source = retrieved as Stripe.Customer;
          billingCustomers.set(candidateId, source);
          cacheCustomer(source).catch(() => {});
        }
        // Monthly checkout aliases use the primary wallet, not a second storage meter.
        const accountId = source.metadata?.primary_stripe_customer_id || source.id;
        let customer = billingCustomers.get(accountId);
        if (!customer) {
          const retrieved = await stripe.customers.retrieve(accountId);
          if ("deleted" in retrieved && retrieved.deleted) continue;
          customer = retrieved as Stripe.Customer;
          billingCustomers.set(accountId, customer);
          cacheCustomer(customer).catch(() => {});
        }
        const account = storageAccounts.get(accountId) || { customer, teamIds: new Set<string>() };
        if (source.metadata?.hostedai_team_id) account.teamIds.add(source.metadata.hostedai_team_id);
        if (customer.metadata?.hostedai_team_id) account.teamIds.add(customer.metadata.hostedai_team_id);
        if (account.teamIds.size > 0) storageAccounts.set(accountId, account);
      } catch (error) {
        console.error(`[Sync] Could not resolve storage account ${candidateId}:`, error);
      }
    }
    // Match the existing primary-account preference: hourly team owner before
    // an unlinked monthly alias. Each provider team can contribute storage only once.
    const storageTeamOwners = new Map<string, string>();
    for (const [accountId, account] of storageAccounts) {
      for (const teamId of account.teamIds) {
        const previousId = storageTeamOwners.get(teamId);
        const previous = previousId ? storageAccounts.get(previousId) : undefined;
        if (!previous || (account.customer.metadata?.billing_type === "hourly" && previous.customer.metadata?.billing_type !== "hourly")) {
          storageTeamOwners.set(teamId, accountId);
        }
      }
    }
    customersToProcess.clear();
    storageTeamOwners.forEach(accountId => customersToProcess.add(accountId));

    const storageResults: Array<{
      customerId: string;
      storageGb: number;
      storageCostCents: number;
    }> = [];

    const stoppedResults: Array<{
      customerId: string;
      stoppedGpuCount: number;
      stoppedCostCents: number;
    }> = [];

    for (const [customerId, account] of storageAccounts) {
      try {
        const { customer } = account;
        const billingTeams = [...account.teamIds].filter(id => storageTeamOwners.get(id) === customerId);
        if (billingTeams.length === 0) continue;
        const teamId = billingTeams.find(id => id === customer.metadata?.hostedai_team_id) || billingTeams[0];

        // Storage and stopped GPUs are metered about every 30 minutes, for the time that actually
        // passed since the last metering. The first metering covers 30 minutes.
        const lastStorageSync = parseInt(customer.metadata?.last_storage_sync_timestamp ?? "", 10);
        const nowSec = Math.floor(Date.now() / 1000);
        const hasLastSync = Number.isFinite(lastStorageSync) && lastStorageSync > 0;
        if (hasLastSync && nowSec - lastStorageSync < 25 * 60) continue; // Metered recently
        // Capped at a day: only today's volume sizes are known, so a long gap is not billed at them.
        const sinceLastSync = hasLastSync ? (nowSec - lastStorageSync) / 60 : BILLING_INTERVAL_MINUTES;
        const meteredMinutes = Math.min(sinceLastSync, MAX_METERED_MINUTES);
        if (sinceLastSync > MAX_METERED_MINUTES) console.warn(`[Sync] Storage for ${customerId} last metered ${Math.round(sinceLastSync / 60)}h ago; billing the last ${MAX_METERED_MINUTES / 60}h`);
        // Stable per metering window, so overlapping runs cannot both charge it.
        const meterKey = `${customerId}_${hasLastSync ? lastStorageSync : "first"}`;
        const meteredMetadata: Record<string, string> = {};

        // === Storage billing ===
        let totalStorageGb = 0;
        try {
          const volumeMap = new Map<number, SharedVolume>();
          for (const billingTeam of billingTeams) {
            const volumes = await getCachedVolumes(billingTeam);
            for (const volume of volumes) {
              if (volume.team_id === billingTeam && !volumeMap.has(volume.id)) volumeMap.set(volume.id, volume);
            }
          }
          for (const vol of volumeMap.values()) {
            // A volume hosted.ai failed to create holds no data the customer can use.
            if (/^(error|failed)$/i.test(vol.status ?? "")) continue;
            totalStorageGb += vol.size_in_gb || 0;
          }

          if (totalStorageGb > 0) {
            // Sub-cent accumulator: carry fractional cents forward across intervals,
            // only post a Stripe charge when the running balance crosses 1¢. This
            // removes the $14.60/mo minimum-charge floor caused by Math.round on
            // each 30-min interval. See PA-159 and src/lib/storage-billing.ts.
            const hoursInInterval = meteredMinutes / 60;
            const meta = customer.metadata ?? {};
            const prevPendingCents = parseFloat(meta.storage_pending_cents ?? "") || 0;
            const prevPendingGbHours = parseFloat(meta.storage_pending_gb_hours ?? "") || 0;
            const prevWindowStart = parseInt(meta.storage_window_started_at ?? "", 10);
            const windowStartedAt = Number.isFinite(prevWindowStart) && prevWindowStart > 0
              ? prevWindowStart
              : nowSec - Math.round(meteredMinutes * 60);

            const result = computeStorageCharge(
              { pendingCents: prevPendingCents, pendingGbHours: prevPendingGbHours, windowStartedAt },
              totalStorageGb,
              storagePriceCentsPerGBHour,
              hoursInInterval,
              nowSec,
            );

            // Saved with the metering time below, after the charge.
            Object.assign(meteredMetadata, {
              storage_pending_cents: result.newState.pendingCents.toFixed(8),
              storage_pending_gb_hours: result.newState.pendingGbHours.toFixed(4),
              storage_window_started_at: result.newState.windowStartedAt.toString(),
            });

            if (result.charge) {
              await stripe.customers.createBalanceTransaction(customerId, {
                amount: result.charge.cents,
                currency: "usd",
                description: result.charge.description,
                metadata: {
                  storage_gb: totalStorageGb.toString(),
                  billing_type: "storage",
                  window_started_at: result.charge.windowStartedAt.toString(),
                  window_ended_at: result.charge.windowEndedAt.toString(),
                  avg_gb: result.charge.avgGb.toString(),
                },
              }, { idempotencyKey: `storage_${meterKey}` });

              const windowMinutes = Math.max(1, Math.round((result.charge.windowEndedAt - result.charge.windowStartedAt) / 60));
              await prisma.walletTransaction.create({
                data: {
                  stripeCustomerId: customerId,
                  teamId: billingTeams.length === 1 ? teamId : null,
                  type: "storage",
                  amountCents: result.charge.cents,
                  description: result.charge.description,
                  billingMinutes: windowMinutes,
                },
              }).catch((e) => console.error(`[Sync] Failed to log storage WalletTransaction for ${customerId}:`, e));

              storageResults.push({ customerId, storageGb: totalStorageGb, storageCostCents: result.charge.cents });
            }
          }
        } catch (storageErr) {
          console.error(`Error billing storage for ${customerId}:`, storageErr);
        }

        // === Stopped instance billing ===
        // Each allocation uses its own saved basis and stopped price, never a fleet average.
        let stoppedGpuCount = 0;
        if (customer.metadata?.billing_type === "hourly") {
        try {
          // Match every provider/local ID shape without discarding the captured rate basis.
          const podMetaRows = await prisma.podMetadata.findMany({
            where: { stripeCustomerId: customerId, hourlyRateCents: { gt: 0 }, OR: [{ billingType: null }, { billingType: { not: "monthly" } }] },
            select: { subscriptionId: true, instanceId: true, hourlyRateCents: true, hourlyRateBasis: true, rateSnapshot: true, launchConfiguration: true, billingType: true },
          });
          const rateBySubId = new Map<string, typeof podMetaRows[number]>();
          for (const m of podMetaRows) {
            const bare = m.subscriptionId.startsWith("instance-")
              ? m.subscriptionId.slice("instance-".length)
              : m.subscriptionId;
            rateBySubId.set(m.subscriptionId, m);
            rateBySubId.set(bare, m);
            if (m.instanceId) rateBySubId.set(String(m.instanceId), m);
          }

          const allSubscriptions = await getCachedSubs(teamId);
          const subMap = new Map<string | number, typeof allSubscriptions[0]>();
          for (const sub of allSubscriptions) {
            if (!subMap.has(sub.id)) subMap.set(sub.id, sub);
          }
          const processedPods = new Set<string>();
          const stoppedPods: StoppedPodInput[] = [];

          for (const sub of subMap.values()) {
            if (sub.status !== "subscribed" && sub.status !== "active") continue;
            if (!sub.pods || sub.pods.length === 0) continue;

            const subId = String(sub.id);
            const rate = rateBySubId.get(subId) ?? rateBySubId.get(`instance-${subId}`);
            // Configured stopped coverage is prepaid once through STEP 1, never fleet-billed.
            if (rate?.hourlyRateBasis === "per_instance") continue;

            for (const pod of sub.pods) {
              const podKey = pod.pod_name || `${sub.id}-${pod.pod_status}`;
              if (processedPods.has(podKey)) continue;
              processedPods.add(podKey);

              const podStatus = (pod.pod_status || "").toLowerCase();
              if (podStatus === "stopped" || podStatus === "paused" || podStatus === "reserved") {
                // Surface revenue gaps: a stopped pod with no PodMetadata rate is
                // not billed (computeStoppedCharge skips it) — log so it's visible.
                if (!rate || getPodHourlyRateCents(rate, 1) === null) {
                  console.warn(`[Sync] Stopped pod ${podKey} (sub ${subId}) has no rate in PodMetadata — not billed`);
                }
                stoppedPods.push({
                  ...(rate || { hourlyRateCents: null }),
                  gpuCount: pod.gpu_count || sub.per_pod_info?.vgpu_count || 1,
                });
              }
            }
          }

          const charge = computeStoppedCharge(
            stoppedPods,
            stoppedInstanceRatePercent,
            meteredMinutes,
          );
          stoppedGpuCount = charge.stoppedGpuCount;
          const stoppedCostCents = charge.stoppedCostCents;

          if (stoppedCostCents > 0) {
            // Dedup guard: unlike the running path (idempotent per interval via
            // prepaidUntil), the stopped path bills every run. If two cron runs
            // race the 25-min storage-sync gate (or a brand-new customer has no
            // timestamp yet), a stopped pod could be billed twice. Skip if we
            // already posted a stopped-reservation charge in the last 5 minutes.
            const recentTxns = await stripe.customers.listBalanceTransactions(customerId, { limit: 20 });
            if (wasStoppedBilledRecently(recentTxns.data, nowSec, 5 * 60)) {
              console.log(`[Sync] Skipping duplicate stopped-reservation charge for ${customerId} (already billed in last 5m)`);
            } else {
              const stoppedDesc = `Reserved: ${stoppedGpuCount} GPU(s) stopped at saved reservation rates`;
              await stripe.customers.createBalanceTransaction(customerId, {
                amount: stoppedCostCents,
                currency: "usd",
                description: stoppedDesc,
                metadata: {
                  stopped_gpu_count: stoppedGpuCount.toString(),
                  billing_type: "stopped_reservation",
                },
              }, { idempotencyKey: `stopped_${meterKey}` });

              // Log stopped reservation charge locally
              await prisma.walletTransaction.create({
                data: {
                  stripeCustomerId: customerId,
                  teamId,
                  type: "stopped_reservation",
                  amountCents: stoppedCostCents,
                  description: stoppedDesc,
                  gpuCount: stoppedGpuCount,
                  billingMinutes: Math.round(meteredMinutes),
                },
              }).catch((e) => console.error(`[Sync] Failed to log stopped WalletTransaction for ${customerId}:`, e));

              stoppedResults.push({ customerId, stoppedGpuCount, stoppedCostCents });
            }
          }
        } catch (stoppedErr) {
          console.error(`Error billing stopped instances for ${customerId}:`, stoppedErr);
        }
        }

        // Recorded after billing. A failed charge loses that window rather than risking a repeat;
        // a crash before this line re-meters it under the same key, which Stripe will not charge twice.
        const metered = await stripe.customers.update(customerId, {
          metadata: { ...meteredMetadata, last_storage_sync_timestamp: nowSec.toString() },
        });
        cacheCustomer(metered as Stripe.Customer).catch(() => {});
      } catch (customerErr) {
        console.error(`Error processing customer ${customerId}:`, customerErr);
      }
    }

    // === STEP 3: NEGATIVE BALANCE ENFORCEMENT ===
    // Check all customers for negative balance and terminate resources
    const negativeBalanceResults: Array<{
      customerId: string;
      email: string;
      balanceCents: number;
      podsTerminated: string[];
    }> = [];

    // Get all unique customers we've processed or have active pods
    const allCustomersToCheck = new Set<string>();
    podResults.forEach(r => allCustomersToCheck.add(r.customerId));
    customersToProcess.forEach(c => allCustomersToCheck.add(c));

    for (const customerId of allCustomersToCheck) {
      try {
        let customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
        if ("deleted" in customer && customer.deleted) continue;
        cacheCustomer(customer).catch(() => {});
        if (customer.metadata?.billing_type !== "hourly") continue;

        const hourlyPods = await prisma.podMetadata.findMany({
          where: { stripeCustomerId: customerId, hourlyRateCents: { gt: 0 }, OR: [{ billingType: null }, { billingType: { not: "monthly" } }] },
          select: { subscriptionId: true, instanceId: true },
        });
        if (hourlyPods.length === 0 && (customer.balance || 0) <= 0) continue; // Idle and not in debt

        // Top up from the saved card first, every run, so a card-on-file customer is never shut
        // down for a debt the refill would have covered. Auto-refill charges the saved card, so it
        // stays hourly-only even though storage reaches monthly accounts.
        const refill = await checkAndRefillWallet(customerId);
        customerRefills.set(customerId, refill);
        if (refill.refilled) customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;

        // Check balance: positive = owes money (negative wallet), negative = has credit
        const balanceCents = customer.balance || 0;
        if (balanceCents <= NEGATIVE_BALANCE_GRACE_CENTS || hourlyPods.length === 0) continue;

        // Shut down only when payment definitely failed: no card, or the card was declined. A
        // refill that just ran (and may not have covered everything), is in progress, or hit a
        // Stripe outage is retried on later runs instead.
        if (!refill.paymentFailed) {
          console.log(`[Sync] Customer ${customerId} owes $${(balanceCents / 100).toFixed(2)}; not shutting down (refill ${refill.refilled ? "ran" : refill.pending ? "in progress" : `not completed: ${refill.error ?? "unknown"}`})`);
          continue;
        }

        // Only the hourly GPUs this customer pays for are stopped. Monthly GPUs are paid for
        // separately, and storage is kept: it keeps billing, and can be deleted by hand.
        const ownedIds = new Set<string>();
        for (const m of hourlyPods) {
          ownedIds.add(m.subscriptionId);
          ownedIds.add(m.subscriptionId.replace(/^instance-/, ""));
          if (m.instanceId) ownedIds.add(m.instanceId);
        }

        console.log(`[Sync] Customer ${customerId} has negative balance: owes $${(balanceCents / 100).toFixed(2)} (${hourlyPods.length} hourly pod(s))`);

        const teamId = customer.metadata?.hostedai_team_id;
        if (!teamId) continue;

        const terminatedPods: string[] = [];

        try {
          const subscriptions = await getCachedSubs(teamId);

          // HAI 2.2: use deleteInstance instead of dead unsubscribeFromPool
          for (const sub of subscriptions) {
            if (!ownedIds.has(String(sub.id))) continue;
            if (sub.status === "subscribed" || sub.status === "active" || sub.status === "subscribing") {
              try {
                console.log(`[Sync] Terminating instance ${sub.id} for negative balance customer ${customerId}`);
                const { deleteInstance } = await import("@/lib/hostedai");
                await deleteInstance(String(sub.id));
                terminatedPods.push(String(sub.id));

                // SAFETY: Never delete pod_metadata — mark it as terminated instead
              } catch (termErr) {
                console.error(`[Sync] Failed to terminate instance ${sub.id}:`, termErr);
              }
            }
          }
        } catch (subErr) {
          console.error(`[Sync] Failed to get subscriptions for ${customerId}:`, subErr);
        }

        // Send notification email
        if (terminatedPods.length > 0 && customer.email) {
          try {
            await sendNegativeBalanceShutdownEmail({
              to: customer.email,
              customerName: customer.name || customer.email.split("@")[0],
              balanceOwedCents: balanceCents,
              podsTerminated: terminatedPods.length,
              volumesDeleted: 0,
              dashboardUrl: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
            });
          } catch (emailErr) {
            console.error(`[Sync] Failed to send negative balance email to ${customer.email}:`, emailErr);
          }
        }

        if (terminatedPods.length > 0) {
          negativeBalanceResults.push({
            customerId,
            email: customer.email || "unknown",
            balanceCents,
            podsTerminated: terminatedPods,
          });
        }
      } catch (err) {
        console.error(`[Sync] Error checking negative balance for ${customerId}:`, err);
      }
    }

    if (negativeBalanceResults.length > 0) {
      console.log(`[Sync] Terminated resources for ${negativeBalanceResults.length} customers with negative balance`);
    }

    // === SUMMARY ===
    const summary = {
      orphanedSubsFixed: reconciliationResults.length,
      podsBilled: podResults.filter(r => r.status === "billed" && (r.amountCents ?? 0) > 0).length,
      podsNotDue: podResults.filter(r => r.status === "not_due").length,
      podsErrors: podResults.filter(r => r.status === "error").length,
      totalPodBilledCents: podResults.reduce((sum, r) => sum + (r.amountCents || 0), 0),
      storageCharges: storageResults.length,
      totalStorageCents: storageResults.reduce((sum, r) => sum + r.storageCostCents, 0),
      stoppedCharges: stoppedResults.length,
      totalStoppedCents: stoppedResults.reduce((sum, r) => sum + r.stoppedCostCents, 0),
      refillsTriggered: Array.from(customerRefills.values()).filter(r => r.refilled).length,
      refillsFailed: Array.from(customerRefills.values()).filter(r => !r.refilled && !r.pending && r.error).length,
      paymentsDeclined: Array.from(customerRefills.values()).filter(r => r.paymentFailed).length,
      negativeBalanceShutdowns: negativeBalanceResults.length,
      backlogsHeld: heldBacklogs.length,
    };

    console.log("[Sync] Completed:", summary);
    try {
      await recordBillingRun(summary.podsErrors);
    } catch (heartbeatError) {
      console.error("[Sync] Failed to record the billing run for /api/status/billing:", heartbeatError);
    }

    return NextResponse.json({
      success: true,
      summary,
      reconciliationResults,
      podResults,
      heldBacklogs,
      storageResults,
      stoppedResults,
    });
  } catch (error) {
    console.error("Sync error:", error);
    return NextResponse.json(
      { error: "Sync failed", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// Helper to get team ID from customer
async function getTeamIdForCustomer(stripe: Stripe, customerId: string): Promise<string | null> {
  try {
    const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
    cacheCustomer(customer).catch(() => {});
    return customer.metadata?.hostedai_team_id || null;
  } catch {
    return null;
  }
}

// GET endpoint to check sync status (protected)
export async function GET(request: NextRequest) {
  const authError = authorizeSync(request);
  if (authError) return authError;

  // Count pods due for billing (including null prepaidUntil)
  const now = new Date();
  const podsDue = await prisma.podMetadata.count({
    where: {
      OR: [
        { prepaidUntil: { lte: now } },
        { prepaidUntil: null },
      ],
      hourlyRateCents: { gt: 0 },
    },
  });

  const podsNotDue = await prisma.podMetadata.count({
    where: {
      prepaidUntil: { gt: now },
      hourlyRateCents: { gt: 0 },
    },
  });

  return NextResponse.json({
    status: "ready",
    billingIntervalMinutes: BILLING_INTERVAL_MINUTES,
    podsDueForBilling: podsDue,
    podsNotYetDue: podsNotDue,
    config: {
      storagePriceCentsPerGBHour: getStoragePricePerGBHourCents(),
      stoppedInstanceRatePercent: getStoppedInstanceRatePercent(),
      autoRefillThresholdCents: WALLET_CONFIG.autoRefillThresholdCents,
      autoRefillAmountCents: WALLET_CONFIG.autoRefillAmountCents,
    },
  });
}
