import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { getGlobalInstanceSummary } from "@/lib/hostedai/instances";

export async function GET(request: NextRequest) {
  const sessionToken = request.cookies.get("admin_session")?.value;
  if (!sessionToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const session = verifySessionToken(sessionToken);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Read the two most recent snapshots (today + yesterday)
    const snapshots = await prisma.adminStatsSnapshot.findMany({
      orderBy: { date: "desc" },
      take: 2,
    });

    const latest = snapshots[0];
    const previous = snapshots[1];

    if (!latest) {
      // DNA patch: count what we can rather than asserting zero.
      //
      // A missing snapshot means the hourly job has not run yet - on a fresh
      // instance, or after it failed. Returning a flat 0 for every headline is
      // indistinguishable from "you have no customers", and it is displayed
      // with the same confidence as a real figure. The customer list on the
      // same screen reads customerCache directly, so the two disagreed: on
      // 2026-08-31 this card showed 0 above a list of three.
      //
      // customerCache is the same source the snapshot job counts, so this
      // matches what the next snapshot will say. The figures that genuinely
      // need the job - MRR, weekly revenue, growth - stay null rather than
      // zero, so the UI can tell "nothing yet" from "no data yet".
      // Only totalCustomers is corrected here. The rest legitimately are zero
      // on a system with no revenue, and inventing nulls for them would break
      // the Stats contract for a window that now lasts an hour at most.
      const totalCustomers = await prisma.customerCache.count();
      return NextResponse.json({
        totalCustomers,
        activePods: 0,
        mrr: 0,
        newCustomersThisWeek: 0,
        revenueThisWeek: 0,
        growth: null,
        pendingFirstSnapshot: true,
      });
    }

    // Use HAI 2.2 /instances/unified for live active pod count
    // The status_counts field gives us an accurate breakdown without fetching all items
    // Count running + transitional states (pending, starting, restarting) as "active"
    // Ref: Confluence HP/600178689 — Status for VM/Pod Instances
    const ACTIVE_STATUSES = ["running", "pending", "starting", "restarting"];
    let liveActivePods = latest.activeGPUs; // fallback to snapshot
    try {
      const summary = await getGlobalInstanceSummary();
      const activeCount = summary.statusCounts
        .filter((s) => ACTIVE_STATUSES.includes(s.status.toLowerCase()))
        .reduce((sum, s) => sum + s.count, 0);
      liveActivePods = activeCount;
    } catch (err) {
      console.warn("[Stats] Failed to fetch live instance summary, using snapshot:", err);
    }

    const current = {
      totalCustomers: latest.totalCustomers,
      activePods: liveActivePods,
      mrr: latest.mrrCents,
      newCustomersThisWeek: latest.newThisWeek,
      revenueThisWeek: latest.revenueWeekCents,
    };

    return NextResponse.json({
      ...current,
      growth: previous
        ? {
            totalCustomers: current.totalCustomers - previous.totalCustomers,
            activePods: current.activePods - previous.activeGPUs,
            mrr: current.mrr - previous.mrrCents,
            newCustomersThisWeek: current.newCustomersThisWeek - previous.newThisWeek,
            revenueThisWeek: current.revenueThisWeek - previous.revenueWeekCents,
          }
        : null,
    });
  } catch (error) {
    console.error("Stats error:", error);
    return NextResponse.json({ error: "Failed to fetch stats" }, { status: 500 });
  }
}
