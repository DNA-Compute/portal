import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { resolveOperatingContext } from "@/lib/auth/account-resolver";
import {
  getUnifiedInstances,
  getUnifiedInstanceDetail,
  PoolSubscription,
} from "@/lib/hostedai";
import type { UnifiedInstance } from "@/lib/hostedai";
import { prisma } from "@/lib/prisma";
import { cacheCustomer } from "@/lib/customer-cache";
import { launchInstance } from "@/lib/instance-launch";
import { getPodHourlyRateCents, getPodStoppedHourlyRateCents } from "@/lib/pod-billing";

// GET - List team instances
export async function GET(request: NextRequest) {
  try {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = verifyCustomerToken(token);
    if (!payload) {
      return NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 401 }
      );
    }

    // PA-175: resolve the OPERATING account, not just the user's own teams.
    // A Read-only / Team Member viewing their owner's team needs the
    // owner's team pods — those live on the owner's customer, not theirs.
    const ctx = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });
    if (!ctx || ctx.allTeamIds.length === 0) {
      return NextResponse.json(
        { error: "No team associated with this account" },
        { status: 400 }
      );
    }

    const customer = ctx.customer;
    cacheCustomer(customer).catch(() => {});
    console.log(`[Instances GET] Resolved ${payload.email}: account=${customer.id}, teams=[${ctx.allTeamIds.join(",")}]`);

    // HAI 2.2: Fetch unified instances from ALL teams in parallel
    const poolSubscriptions: PoolSubscription[] = [];
    const teamFetchResults = await Promise.all(
      ctx.allTeamIds.map(async (teamId) => {
        try {
          const result = await getUnifiedInstances(teamId);
          return result.items || [];
        } catch (error) {
          console.error(`Failed to fetch unified instances for team ${teamId}:`, error);
          return [];
        }
      })
    );

    // Convert unified instances to PoolSubscription shape for dashboard compatibility
    const allUnified = teamFetchResults.flat();
    for (const ui of allUnified) {
      poolSubscriptions.push({
        id: ui.id,
        pool_id: ui.id, // use instance id as pool_id for compatibility
        pool_name: ui.name, // instance name (user-given), not pool_name
        status: ui.status.toLowerCase(), // "Running" → "running" for card status checks
        region: ui.region ? {
          region_name: ui.region.region_name,
          city: ui.region.city,
        } : undefined,
        per_pod_info: {
          image_name: ui.pod_info?.model ? `${ui.pod_info.vendor || ""} ${ui.pod_info.model}`.trim() : undefined,
          vgpu_count: ui.pod_info?.vgpu_count || 1,
          vcpu_count: ui.instance_type?.cpu_cores,
          ram_mb: ui.instance_type?.ram_mb,
        },
        pods: [{
          pod_name: ui.name,
          pod_status: ui.status.toLowerCase(),
          gpu_count: ui.pod_info?.vgpu_count || 1,
        }],
      });
    }

    console.log(`[Instances GET] Fetched ${poolSubscriptions.length} unified instances across ${ctx.allTeamIds.length} team(s)`);

    // Fetch instance details in parallel to get shared_volumes and root_disk info
    if (poolSubscriptions.length > 0) {
      const detailResults = await Promise.all(
        poolSubscriptions.map(async (sub) => {
          try {
            return await getUnifiedInstanceDetail(String(sub.id));
          } catch {
            return null;
          }
        })
      );

      for (let i = 0; i < poolSubscriptions.length; i++) {
        const detail = detailResults[i];
        if (!detail) continue;

        const sharedVols = detail.shared_volumes || [];
        const rootDisk = detail.root_disk;

        poolSubscriptions[i].storage_details = {
          ephemeral_storage_gb: rootDisk?.size_gb,
          shared_volumes: sharedVols.map((v) => ({
            id: String(v.id),
            name: v.name,
            size_in_gb: v.size_in_gb,
            mount_point: v.mount_point,
            mount_status: v.mount_status,
            mount_operation: v.mount_operation,
          })),
        };

        // Backfill CPU/RAM from detail if not already set from list response
        if (detail.instance_type && !poolSubscriptions[i].per_pod_info?.vcpu_count) {
          poolSubscriptions[i].per_pod_info = {
            ...poolSubscriptions[i].per_pod_info,
            vcpu_count: detail.instance_type.cpu_cores,
            ram_mb: detail.instance_type.ram_mb,
          };
        }

        // PA-183: the LIST endpoint's pod_info often omits vgpu_count (or
        // reports 1 while the instance is still Pending), so a multi-GPU
        // instance renders as "1 GPU". The DETAIL endpoint carries the real
        // provisioned count — backfill it here so the card shows e.g. "2 GPU".
        const detailVgpu = detail.pod_info?.vgpu_count;
        if (typeof detailVgpu === "number" && detailVgpu > 0) {
          poolSubscriptions[i].per_pod_info = {
            ...poolSubscriptions[i].per_pod_info,
            vgpu_count: detailVgpu,
          };
          if (poolSubscriptions[i].pods?.[0]) {
            poolSubscriptions[i].pods![0].gpu_count = detailVgpu;
          }
        }
      }
    }

    // Fetch pod metadata for unified instances
    const instanceIds = poolSubscriptions.map(s => String(s.id));
    type MetaValue = { displayName: string | null; notes: string | null; gpuCount?: number; gpuSharePercent?: number; hourlyRate?: number; hourlyRateBasis?: string; stoppedRatePercent?: number; stoppedHourlyRate?: number; startupScriptStatus?: string | null; stripeSubscriptionId?: string; billingType?: string; deployStatus?: string | null; deployStatusReason?: string | null };
    let podMetadata: Record<string, MetaValue> = {};
    let hfDeployments: Record<string, {
      id: string;
      hfItemId: string;
      hfItemName: string;
      status: string;
      errorMessage: string | null;
      createdAt: string;
      netdata?: boolean;
      netdataPort?: number | null;
      openWebUI?: boolean;
      webUiPort?: number | null;
    }> = {};

    if (instanceIds.length > 0) {
      try {
        // Fetch metadata by instanceId or subscriptionId (legacy records may use subscriptionId = instance id)
        const metadata = await prisma.podMetadata.findMany({
          where: {
            OR: [
              { instanceId: { in: instanceIds } },
              { subscriptionId: { in: instanceIds } },
            ],
          },
        });
        // Tie-breaker for the (rare) case where multiple rows reference the
        // same HAI instance: prefer the row that has instanceId populated, then
        // the row whose subscriptionId uses the canonical "instance-" prefix,
        // then an explicit billingType. This keeps a stray reconciliation-style
        // row from overwriting a properly-deployed monthly row when both exist.
        const rowScore = (m: typeof metadata[number]) => {
          let s = 0;
          if (m.instanceId) s += 4;
          if (m.subscriptionId.startsWith("instance-")) s += 2;
          if (m.billingType) s += 1;
          return s;
        };
        const sortedMeta = [...metadata].sort((a, b) => rowScore(a) - rowScore(b));
        podMetadata = sortedMeta.reduce((acc, m) => {
          const snapshot = m.rateSnapshot && typeof m.rateSnapshot === "object" && !Array.isArray(m.rateSnapshot) ? m.rateSnapshot : null;
          const configuration = m.launchConfiguration && typeof m.launchConfiguration === "object" && !Array.isArray(m.launchConfiguration) ? m.launchConfiguration : null;
          const resources = configuration && configuration.resources && typeof configuration.resources === "object" && !Array.isArray(configuration.resources) ? configuration.resources : null;
          const sharePercent = resources?.gpuSharePercent;
          const hourlyRateCents = getPodHourlyRateCents(m, 1);
          const stoppedHourlyRateCents = m.hourlyRateBasis === "per_instance" ? getPodStoppedHourlyRateCents(m, 1, 0) : null;
          const metaValue: MetaValue = {
            displayName: m.displayName,
            notes: m.notes,
            gpuCount: configuration && typeof configuration.gpuCount === "number" && Number.isInteger(configuration.gpuCount) && configuration.gpuCount > 0 ? configuration.gpuCount : undefined,
            // A fractional launch is one share of one GPU; whole-GPU launches omit it.
            gpuSharePercent: typeof sharePercent === "number" && Number.isInteger(sharePercent) && sharePercent > 0 && sharePercent < 100 ? sharePercent : undefined,
            hourlyRate: hourlyRateCents !== null ? hourlyRateCents / 100 : undefined,
            hourlyRateBasis: m.hourlyRateBasis || "per_gpu",
            stoppedRatePercent: hourlyRateCents !== null && snapshot && typeof snapshot.stoppedRatePercent === "number" && Number.isFinite(snapshot.stoppedRatePercent) && snapshot.stoppedRatePercent >= 0 && snapshot.stoppedRatePercent <= 100 ? snapshot.stoppedRatePercent : undefined,
            stoppedHourlyRate: stoppedHourlyRateCents !== null ? stoppedHourlyRateCents / 100 : undefined,
            startupScriptStatus: m.startupScriptStatus,
            stripeSubscriptionId: m.stripeSubscriptionId || undefined,
            billingType: m.billingType || undefined,
            deployStatus: m.deployStatus,
            deployStatusReason: m.deployStatusReason,
          };
          // Index by instanceId (primary key for 2.2)
          if (m.instanceId) acc[m.instanceId] = metaValue;
          // Also index by subscriptionId for records created during transition
          acc[m.subscriptionId] = metaValue;
          return acc;
        }, {} as Record<string, MetaValue>);

        // Fetch HuggingFace deployments
        const deployments = await prisma.huggingFaceDeployment.findMany({
          where: { subscriptionId: { in: instanceIds } },
          orderBy: { createdAt: 'desc' },
        });

        hfDeployments = deployments.reduce((acc, d) => {
          if (!acc[d.subscriptionId]) {
            acc[d.subscriptionId] = {
              id: d.id,
              hfItemId: d.hfItemId,
              hfItemName: d.hfItemName,
              status: d.status,
              errorMessage: d.errorMessage,
              createdAt: d.createdAt.toISOString(),
              netdata: d.netdata,
              netdataPort: d.netdataPort,
              openWebUI: d.openWebUI,
              webUiPort: d.webUiPort,
            };
          }
          return acc;
        }, {} as Record<string, { id: string; hfItemId: string; hfItemName: string; status: string; errorMessage: string | null; createdAt: string; netdata?: boolean; netdataPort?: number | null; openWebUI?: boolean; webUiPort?: number | null }>);
      } catch (error) {
        console.error("Failed to fetch pod metadata:", error);
      }
    }

    return NextResponse.json({ instances: [], poolSubscriptions, podMetadata, hfDeployments });
  } catch (error) {
    console.error("List instances error:", error);
    return NextResponse.json(
      { error: "Failed to list instances" },
      { status: 500 }
    );
  }
}

// POST - Validate, quote, and provision a configured instance.
export async function POST(request: NextRequest) {
  return launchInstance(request);
}

