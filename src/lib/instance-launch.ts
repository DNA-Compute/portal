import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import type Stripe from "stripe";
import { z } from "zod";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import type { AuthenticatedCustomer } from "@/lib/auth/helpers";
import { requirePermission } from "@/lib/auth/audit";
import { resolveOperatingContext } from "@/lib/auth/account-resolver";
import { configuredLaunchSchema, withoutLaunchSecrets } from "@/lib/launch-config";
import type { ConfiguredLaunchRequest, LaunchQuote, ResolvedLaunchConfiguration } from "@/lib/launch-config";
import { resolveAndQuoteLaunch } from "@/lib/launch-quote";
import { prepareLaunchSoftware, completeLaunchSoftware } from "@/lib/launch-software";
import {
  createInstance, deleteInstance, createSharedVolume, deleteSharedVolume,
  getSharedVolumes, getTeamWorkspaces, getUnifiedInstanceDetail,
} from "@/lib/hostedai";
import { prisma } from "@/lib/prisma";
import { cacheCustomer } from "@/lib/customer-cache";
import { getWalletBalance, deductUsage, refundDeployment } from "@/lib/wallet";
import { monitorDeployStatus } from "@/lib/deploy-monitor";
import { installMetricsCollector } from "@/lib/metrics-collector";
import { runStartupScript } from "@/lib/startup-script-runner";
import { WORKSPACE_SETUP_SCRIPT } from "@/lib/startup-scripts";
import { logGPULaunched, getFirstGpuLaunch } from "@/lib/activity";
import { sendOnboardingEvent } from "@/lib/email/onboarding-events";
import { sendGpuLaunchedEmail } from "@/lib/email";
import { generateCustomerToken } from "@/lib/customer-auth";

class LaunchRequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

// Serializes launches for an operating account in this server process.
const deployingAccounts = new Set<string>();

async function resolveRequest(auth: AuthenticatedCustomer, body: unknown): Promise<{
  input: ConfiguredLaunchRequest; resolved: ResolvedLaunchConfiguration; quote: LaunchQuote;
}> {
  const input = configuredLaunchSchema.parse(body);
  const { resolved, quote } = await resolveAndQuoteLaunch(auth, input.configuration);
  if (input.quoteFingerprint !== quote.fingerprint) {
    throw new LaunchRequestError("This quote has changed. Review the updated configuration and price before launching.", 409);
  }
  return { input, resolved, quote };
}

async function subscriptionForLaunch(auth: AuthenticatedCustomer, productId: string, requestedId?: string): Promise<string> {
  const product = await prisma.gpuProduct.findUnique({ where: { id: productId } });
  if (!product?.stripePriceId) throw new LaunchRequestError("Monthly product has no subscription price.");
  const { stripe } = auth;
  const context = await resolveOperatingContext({ email: auth.payload.email, jwtCustomerId: auth.payload.customerId, activeAccountId: auth.payload.activeAccountId });
  if (!context || context.accountId !== auth.accountId) throw new LaunchRequestError("The active billing account changed. Refresh and try again.", 403);
  const allowedCustomers = new Set([auth.accountId, ...context.monthlyCustomerIds]);
  const candidates: Stripe.Subscription[] = [];
  if (requestedId) candidates.push(await stripe.subscriptions.retrieve(requestedId));
  else {
    for (const customerId of allowedCustomers) {
      for await (const subscription of stripe.subscriptions.list({ customer: customerId, status: "active", limit: 100 })) {
        if (subscription.items.data.some(item => item.price.id === product.stripePriceId)) candidates.push(subscription);
      }
    }
  }
  for (const subscription of candidates) {
    const ownerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
    const matchingItems = subscription.items.data.filter(item => item.price.id === product.stripePriceId);
    if (!allowedCustomers.has(ownerId) || subscription.status !== "active" || matchingItems.length === 0) {
      if (requestedId) throw new LaunchRequestError("Subscription does not belong to this account and selected active product.", 403);
      continue;
    }
    const slots = matchingItems.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
    const pods = await prisma.podMetadata.findMany({ where: { stripeSubscriptionId: subscription.id } });
    let occupied = 0;
    for (const pod of pods) {
      // Never delete historical metadata just to free an entitlement slot.
      if (!pod.instanceId) { occupied++; continue; }
      try {
        await getUnifiedInstanceDetail(pod.instanceId);
        occupied++;
      } catch (error) {
        // Only an explicit provider 404 frees a slot; transient failures fail closed.
        if (!(error instanceof Error && error.message.includes("(404)"))) occupied++;
      }
    }
    if (occupied < slots) return subscription.id;
  }
  throw new LaunchRequestError(candidates.length ? "All subscription slots are occupied. Terminate an instance before launching another." : "No active subscription found for this monthly product.", candidates.length ? 409 : 400);
}

async function acquireDeployLock(auth: AuthenticatedCustomer): Promise<() => Promise<void>> {
  const { stripe, customer } = auth;
  if (deployingAccounts.has(customer.id)) throw new LaunchRequestError("Another GPU deployment is in progress.", 429);
  deployingAccounts.add(customer.id);
  const timestamp = String(Math.floor(Date.now() / 1000));
  try {
    const fresh = await stripe.customers.retrieve(customer.id);
    if (fresh.deleted) throw new LaunchRequestError("Account is unavailable.", 403);
    const lockTime = Number(fresh.metadata.deploy_lock);
    if (lockTime && Number(timestamp) - lockTime < 180) throw new LaunchRequestError("Another GPU deployment is in progress. Please wait a moment.", 429);
    const locked = await stripe.customers.update(customer.id, { metadata: { deploy_lock: timestamp } });
    void cacheCustomer(locked).catch(error => console.error("[Launch] Customer cache update failed:", error));
  } catch (error) {
    deployingAccounts.delete(customer.id);
    throw error;
  }
  return async () => {
    try {
      const fresh = await stripe.customers.retrieve(customer.id);
      if (!fresh.deleted && fresh.metadata.deploy_lock === timestamp) {
        const unlocked = await stripe.customers.update(customer.id, { metadata: { deploy_lock: "" } });
        void cacheCustomer(unlocked).catch(error => console.error("[Launch] Customer cache update failed:", error));
      }
    } catch (error) { console.error("[Launch] Failed to release deployment lock:", error); }
    finally { deployingAccounts.delete(customer.id); }
  };
}

async function awaitVolumeReady(teamId: string, volumeId: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const volumes = await getSharedVolumes(teamId);
    const status = volumes.find(volume => volume.id === volumeId)?.status?.toLowerCase();
    if (status && ["available", "ready", "active"].includes(status)) return;
    if (status && ["failed", "error", "deleted"].includes(status)) throw new LaunchRequestError("Shared storage could not be provisioned.", 503);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 3000);
    await promise;
  }
  throw new LaunchRequestError("Shared storage did not become ready. The instance was not launched.", 503);
}

async function notifyWhenReady(auth: AuthenticatedCustomer, input: ConfiguredLaunchRequest, resolved: ResolvedLaunchConfiguration, quote: LaunchQuote, instanceId: string): Promise<void> {
  const isMonthlyDeploy = resolved.billingType === "monthly";
  const result = await monitorDeployStatus({ instanceId, customerId: auth.customer.id, prechargedCents: isMonthlyDeploy ? 0 : quote.rate.prepayCents, isMonthlyDeploy });
  if (!result.ready) return;
  const { customer, payload } = auth;
  const gpuCount = resolved.configuration.gpuCount;
  const priorLaunch = await getFirstGpuLaunch(customer.id);
  await logGPULaunched(customer.id, resolved.productName, gpuCount, input.name, instanceId);
  sendOnboardingEvent({
    type: "gpu.launched", email: payload.email,
    name: customer.name || customer.email?.split("@")[0] || "Unknown",
    metadata: { "Stripe Customer ID": customer.id, "GPU Type": resolved.productName, "Pod Name": input.name, "GPU Count": gpuCount, "Billing Type": resolved.billingType, "Instance ID": instanceId, "First GPU": priorLaunch ? "No" : "Yes" },
  });
  if (customer.email) {
    const token = generateCustomerToken(payload.email.toLowerCase(), customer.id);
    await sendGpuLaunchedEmail({ to: customer.email, customerName: customer.name || customer.email.split("@")[0], poolName: resolved.productName, gpuCount, dashboardUrl: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?token=${token}` });
  }
}

export async function launchInstance(request: NextRequest): Promise<NextResponse> {
  let releaseLock: (() => Promise<void>) | undefined;
  let auth: AuthenticatedCustomer | undefined;
  let prechargedCents = 0;
  let createdVolumeId: number | undefined;
  let acceptedInstanceId: string | undefined;
  let metadataSaved = false;
  try {
    const authenticated = await getAuthenticatedCustomer(request);
    if (authenticated instanceof NextResponse) return authenticated;
    auth = authenticated;
    const denial = requirePermission(auth, "gpu.provision", request);
    if (denial) return denial;
    const teamId = auth.teamId;
    if (!teamId) throw new LaunchRequestError("No team associated with this account.");
    const { input, resolved, quote } = await resolveRequest(auth, await request.json());
    const configuration = resolved.configuration;
    if (resolved.billingType !== "monthly" && input.stripeSubscriptionId) throw new LaunchRequestError("A monthly subscription cannot pay for an hourly product.");
    const keyIds = [...new Set(input.sshKeyIds)];
    const keys = keyIds.length ? await prisma.sSHKey.findMany({ where: { id: { in: keyIds }, stripeCustomerId: auth.customer.id }, select: { id: true, publicKey: true } }) : [];
    if (keys.length !== keyIds.length) throw new LaunchRequestError("One or more SSH keys do not belong to the operating account.", 403);
    const prepared = await prepareLaunchSoftware(auth, resolved);
    const workspaces = await getTeamWorkspaces(teamId);
    if (!workspaces[0]) throw new LaunchRequestError("No workspace is available for this team.");
    releaseLock = await acquireDeployLock(auth);
    const isMonthlyDeploy = resolved.billingType === "monthly";
    const subscriptionId = isMonthlyDeploy ? await subscriptionForLaunch(auth, configuration.productId, input.stripeSubscriptionId) : undefined;
    const prepaidAmountCents = isMonthlyDeploy ? 0 : quote.rate.prepayCents;
    if (prepaidAmountCents > 0) {
      const wallet = await getWalletBalance(auth.customer.id);
      if (wallet.availableBalance < prepaidAmountCents) throw new LaunchRequestError(`Insufficient wallet balance. Need $${(prepaidAmountCents / 100).toFixed(2)}, have $${(wallet.availableBalance / 100).toFixed(2)}.`, 402);
      const debit = await deductUsage(auth.customer.id, quote.rate.minimumBillingMinutes / 60, `GPU deploy: ${resolved.productName}`, quote.rate.instanceHourlyCents, `predeploy_${auth.customer.id}_${randomBytes(16).toString("hex")}`);
      if (!debit.success) throw new LaunchRequestError("Failed to process deployment payment.", 402);
      prechargedCents = prepaidAmountCents;
    }
    const sharedVolumes: number[] = [];
    if (configuration.storage.mode === "existing") sharedVolumes.push(configuration.storage.volumeId);
    if (configuration.storage.mode === "new") {
      const volume = await createSharedVolume({ team_id: teamId, region_id: configuration.regionId, name: `${input.name}-storage-${Date.now()}`, storage_block_id: configuration.storage.blockId });
      createdVolumeId = volume.id;
      await awaitVolumeReady(teamId, volume.id);
      sharedVolumes.push(volume.id);
    }
    const instance = await createInstance({
      name: input.name, service_id: prepared.serviceId ?? resolved.serviceId,
      region_id: configuration.regionId, instance_type_id: configuration.instanceTypeId,
      image_hash: configuration.imageHash, root_storage_type_id: configuration.rootStorageBlockId,
      team_id: teamId, workspace_id: workspaces[0].id,
      ...(keys.length ? { public_keys: keys.map(key => key.publicKey) } : {}),
      ...(resolved.serviceType === "cpu_gpu_card"
        ? { vm_opts: { gpu_card_count: configuration.gpuCount, passthrough_accelerators: configuration.gpuModelId!, networks: [] } }
        : { pod_opts: {
          pool_id: configuration.poolId, vgpus: configuration.gpuCount, shared_volumes: sharedVolumes,
          rootfs_enabled: resolved.podOptions?.rootfsEnabled ?? false,
          ...(resolved.podOptions?.guaranteedGpuSharePercent !== undefined
            ? { guaranteed_gpu_share_percent: resolved.podOptions.guaranteedGpuSharePercent }
            : {}),
        } }),
    });
    acceptedInstanceId = typeof instance === "string" ? instance : instance.id;
    if (!acceptedInstanceId) throw new LaunchRequestError("The provider did not return an instance identifier.", 502);
    const instanceId = acceptedInstanceId;
    const deployTime = new Date();
    const metricsToken = randomBytes(32).toString("hex");
    await prisma.podMetadata.create({ data: {
      subscriptionId: `instance-${instanceId}`, instanceId, stripeCustomerId: auth.customer.id,
      displayName: input.name, deployTime,
      prepaidUntil: isMonthlyDeploy ? null : new Date(deployTime.getTime() + quote.rate.minimumBillingMinutes * 60_000),
      prepaidAmountCents, poolId: configuration.poolId ? String(configuration.poolId) : null,
      productId: configuration.productId, hourlyRateCents: isMonthlyDeploy ? 0 : quote.rate.instanceHourlyCents,
      hourlyRateBasis: "per_instance",
      launchConfiguration: { ...withoutLaunchSecrets(configuration), resources: quote.resources, serviceId: prepared.serviceId ?? resolved.serviceId, serviceType: resolved.serviceType } as Prisma.InputJsonValue,
      rateSnapshot: quote.rate as unknown as Prisma.InputJsonValue,
      metricsToken, startupScript: prepared.startupScript || null, startupScriptStatus: "pending",
      deployStatus: "provisioning", billingType: resolved.billingType,
      stripeSubscriptionId: subscriptionId ?? null, sharedVolumeId: sharedVolumes[0] ?? null,
    } });
    metadataSaved = true;
    // Persisted metadata/monitor now own billing and failure refunds. Never refund
    // a live accepted instance merely because a notification or software hook fails.
    prechargedCents = 0;
    if (prepaidAmountCents > 0) {
      await prisma.walletTransaction.create({ data: {
        stripeCustomerId: auth.customer.id, teamId, type: "gpu_deploy", amountCents: prepaidAmountCents,
        description: `GPU deploy: ${resolved.productName}`, subscriptionId: instanceId,
        poolId: configuration.poolId ?? null, gpuCount: configuration.gpuCount,
        hourlyRateCents: quote.rate.instanceHourlyCents, billingMinutes: quote.rate.minimumBillingMinutes, syncCycleId: `deploy_${instanceId}`,
      } }).catch(error => console.error("[Launch] Failed to log wallet transaction:", error));
    }
    void notifyWhenReady(auth, input, resolved, quote, instanceId).catch(error => console.error(`[Launch] Readiness follow-up failed for ${instanceId}:`, error));
    let softwareError: string | undefined;
    try {
      await completeLaunchSoftware(auth, resolved, prepared, instanceId);
    } catch (error) {
      console.error(`[Launch] Software setup failed for ${instanceId}:`, error);
      softwareError = "Instance provisioning started, but software setup failed. Check deployment details before using it.";
      await prisma.podMetadata.update({ where: { instanceId }, data: { startupScriptStatus: "failed" } }).catch(updateError => console.error("[Launch] Could not record software failure:", updateError));
    }
    void installMetricsCollector(instanceId, teamId, metricsToken).catch(error => console.error(`[Metrics] Failed for ${instanceId}:`, error));
    if (!softwareError) {
      void runStartupScript(instanceId, teamId, WORKSPACE_SETUP_SCRIPT + "\n" + (prepared.startupScript || ""), prepared.startupScriptPresetId).catch(error => console.error(`[Startup] Failed for ${instanceId}:`, error));
    }
    return NextResponse.json({ success: true, instance_id: instanceId, deploy_status: "provisioning", message: "GPU deployment started — provisioning.", ...(softwareError ? { software_error: softwareError } : {}) });
  } catch (error) {
    const cleanupErrors: string[] = [];
    let safeToCompensate = !acceptedInstanceId;
    if (acceptedInstanceId && !metadataSaved) {
      try { await deleteInstance(acceptedInstanceId); safeToCompensate = true; }
      catch (cleanupError) { console.error("[Launch] Failed to remove untracked instance:", cleanupError); cleanupErrors.push(`Instance ${acceptedInstanceId} could not be removed; contact support.`); }
    }
    if (safeToCompensate && !metadataSaved) {
      if (createdVolumeId !== undefined) {
        try { await deleteSharedVolume(createdVolumeId); }
        catch (cleanupError) { console.error("[Launch] Failed to remove new volume:", cleanupError); cleanupErrors.push(`New storage volume ${createdVolumeId} could not be removed; contact support.`); }
      }
      if (prechargedCents > 0 && auth) {
        const refund = await refundDeployment(auth.customer.id, prechargedCents, "Refund: configured deployment failed").catch(() => ({ success: false }));
        if (!refund.success) cleanupErrors.push("Deployment refund could not be completed; contact support.");
      }
    }
    if (acceptedInstanceId && !safeToCompensate) {
      return NextResponse.json({
        success: true, instance_id: acceptedInstanceId, deploy_status: "provisioning",
        configuration_saved: metadataSaved,
        launch_warning: metadataSaved
          ? "The instance exists, but post-launch setup failed. Check its details and contact support before retrying setup."
          : `Instance ${acceptedInstanceId} exists, but its allocation could not be recorded or automatically removed. Contact support before launching a replacement.`,
      }, { status: 202 });
    }
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid launch request.", details: error.flatten() }, { status: 400 });
    const message = error instanceof Error ? error.message : "Failed to create instance.";
    const status = error && typeof error === "object" && "status" in error && typeof error.status === "number" ? error.status : /Insufficient resources|10189007/.test(message) ? 503 : 500;
    console.error("[Launch] Failed:", error);
    return NextResponse.json({ error: message, ...(cleanupErrors.length ? { cleanupErrors } : {}) }, { status });
  } finally {
    await releaseLock?.();
  }
}
