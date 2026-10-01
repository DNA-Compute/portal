/**
 * Admin Pods API
 *
 * Returns ALL pods with ownership info, billing, and SSH details.
 * Pod list comes from the pool overview cache (refreshed every 2 min).
 * SSH connection info is fetched from hosted.ai on demand.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/admin";
import { getConnectionInfo, getAllUnifiedInstances } from "@/lib/hostedai";
import type { UnifiedInstance } from "@/lib/hostedai";
import { getStripeTeamMap } from "@/lib/admin-cache";
import { prisma } from "@/lib/prisma";
import { getPodGpuCount, getPodHourlyRateCents } from "@/lib/pod-billing";

export interface AdminPod {
  subscriptionId: string;
  teamId: string;
  poolId: number;
  poolName: string;
  status: string;
  /** Kubernetes-level container status (e.g., Running, ContainerStatusUnknown) */
  podStatus?: string;
  /** Whether this pod is considered dead/unhealthy */
  isDead: boolean;
  vgpuCount: number;
  podName?: string;
  // Owner info (if matched to a customer)
  owner?: {
    customerId: string;
    email: string;
    name: string;
  };
  // SSH connection info
  ssh?: {
    host: string;
    port: number;
    username: string;
    password?: string;
  };
  // Metrics
  metrics?: {
    tflopsUsage?: number;
    vramUsage?: number;
  };
  // Metadata from our DB
  metadata?: {
    displayName?: string;
    deployTime?: string;
    notes?: string;
  };
  // Billing info
  billing?: {
    hourlyRateCents: number | null;
    monthlyRateCents?: number | null;
    billingType?: string; // "hourly" | "monthly"
    prepaidUntil?: string;
    stripeCustomerId?: string;
  };
  // Timestamps
  createdAt?: string;
}

export async function GET(request: NextRequest) {
  // Verify admin session
  const sessionToken = request.cookies.get("admin_session")?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const session = verifySessionToken(sessionToken);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await fetchPodsData();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Admin pods error:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to fetch pods";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

async function fetchPodsData(): Promise<{ pods: AdminPod[]; summary: Record<string, number> }> {
  // Use HAI 2.2 unified instances API for actual pod data (not pool subscriptions)
  const [instances, teamToCustomer] = await Promise.all([
    getAllUnifiedInstances(),
    getStripeTeamMap(),
  ]);

  // Active statuses (running or transitional)
  const ACTIVE_STATUSES = ["running", "pending", "starting", "restarting"];
  const DEAD_STATUSES = ["error", "failed", "unknown"];

  // Build pods from unified instances
  const allPods: AdminPod[] = [];
  const teamIdsWithPods = new Set<string>();

  for (const inst of instances) {
    const teamId = inst.team?.id || "";
    const stripeInfo = teamId ? teamToCustomer.get(teamId) : undefined;
    const statusLower = inst.status?.toLowerCase() || "";
    const isDead = DEAD_STATUSES.includes(statusLower);

    allPods.push({
      subscriptionId: inst.id,
      teamId,
      poolId: 0, // Not directly available from unified API
      poolName: inst.pod_info?.pool_name || inst.service?.name || "Unknown",
      status: statusLower,
      podStatus: inst.status,
      isDead,
      vgpuCount: inst.pod_info?.vgpu_count || 1,
      podName: inst.name,
      owner: stripeInfo ? {
        customerId: stripeInfo.customerId,
        email: stripeInfo.email,
        name: stripeInfo.name || "Unknown",
      } : (inst.team?.name ? {
        customerId: "",
        email: "",
        name: inst.team.name,
      } : undefined),
      ssh: undefined,
      metrics: { tflopsUsage: undefined, vramUsage: undefined },
      createdAt: inst.created_at,
    });

    if (teamId) teamIdsWithPods.add(teamId);
  }

  console.log(`[Admin Pods] ${allPods.length} instances from unified API, ${teamIdsWithPods.size} unique teams`);

  // Fetch SSH connection info for teams with pods (parallel, with timeout)
  const teamsArray = Array.from(teamIdsWithPods);
  const connInfoMap = new Map<string, Map<string, { host: string; port: number; username: string; password?: string }>>();

  await Promise.all(
    teamsArray.map(async (teamId) => {
      try {
        const rawConnectionInfo = await getConnectionInfo(teamId).catch(() => []);
        const connectionInfo = Array.isArray(rawConnectionInfo) ? rawConnectionInfo : [];
        const connMap = new Map<string, { host: string; port: number; username: string; password?: string }>();
        for (const conn of connectionInfo) {
          if (conn.id && conn.pods && conn.pods.length > 0) {
            const pod = conn.pods[0];
            if (pod.ssh_info?.cmd) {
              let sshMatch = pod.ssh_info.cmd.match(/ssh\s+-p\s+(\d+)\s+(\w+)@([^\s]+)/);
              if (!sshMatch) {
                sshMatch = pod.ssh_info.cmd.match(/ssh\s+(\w+)@([^\s]+)\s+-p\s+(\d+)/);
                if (sshMatch) {
                  connMap.set(String(conn.id), {
                    host: sshMatch[2],
                    port: parseInt(sshMatch[3], 10),
                    username: sshMatch[1],
                    password: pod.ssh_info.pass,
                  });
                  continue;
                }
              }
              if (sshMatch) {
                connMap.set(String(conn.id), {
                  host: sshMatch[3],
                  port: parseInt(sshMatch[1], 10),
                  username: sshMatch[2],
                  password: pod.ssh_info.pass,
                });
              }
            }
          }
        }
        connInfoMap.set(teamId, connMap);
      } catch {
        // SSH info is optional — skip on error
      }
    })
  );

  // Match SSH info to pods (connection info is keyed by subscription ID)
  for (const pod of allPods) {
    const connMap = connInfoMap.get(pod.teamId);
    if (connMap) {
      // Try exact match first, then try any connection for this team
      const ssh = connMap.get(pod.subscriptionId) || (connMap.size > 0 ? connMap.values().next().value : undefined);
      if (ssh) pod.ssh = ssh;
    }
  }

  // A pool/name cannot identify a purchased configuration. Hourly prices come
  // only from the saved allocation; monthly display uses its exact product.
  const monthlyPrices = new Map<string, number | null>();
  try {
    const products = await prisma.gpuProduct.findMany({
      select: { id: true, pricePerMonthCents: true },
    });
    for (const product of products) monthlyPrices.set(product.id, product.pricePerMonthCents);
  } catch (priceError) {
    console.warn("[Admin Pods] Could not load monthly prices:", priceError);
  }

  // Enrich with PodMetadata from our database (for display names, notes, deploy times)
  try {
    const allMeta = await prisma.podMetadata.findMany({
      select: {
        subscriptionId: true,
        displayName: true,
        notes: true,
        createdAt: true,
        hourlyRateCents: true,
        hourlyRateBasis: true,
        rateSnapshot: true,
        launchConfiguration: true,
        billingType: true,
        productId: true,
        instanceId: true,
        prepaidUntil: true,
        stripeCustomerId: true,
        poolId: true,
      },
    });

    // Build lookup maps
    const metaBySubId = new Map<string, typeof allMeta[number]>();
    for (const meta of allMeta) {
      metaBySubId.set(meta.subscriptionId, meta);
      if (meta.instanceId) metaBySubId.set(meta.instanceId, meta);
      if (meta.subscriptionId.startsWith("instance-")) {
        metaBySubId.set(meta.subscriptionId.slice("instance-".length), meta);
      }
    }

    for (const pod of allPods) {
      const meta = metaBySubId.get(pod.subscriptionId);

      if (meta) {
        pod.vgpuCount = getPodGpuCount(meta, pod.vgpuCount);
        pod.metadata = {
          displayName: meta.displayName || undefined,
          deployTime: meta.createdAt?.toISOString(),
          notes: meta.notes || undefined,
        };
        // Never replace a purchased rate with today's catalog price or a neighbor's rate.
        pod.billing = {
          hourlyRateCents: getPodHourlyRateCents(meta, pod.vgpuCount),
          monthlyRateCents: meta.billingType === "monthly" && meta.productId ? monthlyPrices.get(meta.productId) ?? null : null,
          billingType: meta.billingType || undefined,
          prepaidUntil: meta.prepaidUntil?.toISOString(),
          stripeCustomerId: meta.stripeCustomerId || undefined,
        };
        pod.createdAt = meta.createdAt?.toISOString();
      }
    }
  } catch (metaError) {
    console.warn("[Admin Pods] Could not fetch pod metadata:", metaError);
  }

  // Calculate summary stats
  // Active = running + transitional states (matches the KPI bar definition)
  const activePods = allPods.filter((p) => ACTIVE_STATUSES.includes(p.status) && !p.isDead);
  const deadPods = allPods.filter((p) => p.isDead);
  const unbilledPods = activePods.filter((p) =>
    !p.billing || (!p.billing.hourlyRateCents && !p.billing.monthlyRateCents)
  );
  const summary = {
    totalPods: allPods.length,
    activePods: activePods.length,
    deadPods: deadPods.length,
    totalVGPUs: activePods.reduce((sum, p) => sum + p.vgpuCount, 0),
    ownedPods: allPods.filter((p) => p.owner).length,
    unownedPods: allPods.filter((p) => !p.owner).length,
    unbilledPods: unbilledPods.length,
  };

  console.log(`[Admin Pods] Total: ${allPods.length} pods, ${summary.activePods} active`);

  return { pods: allPods, summary };
}
