import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import { requirePermission } from "@/lib/auth/audit";
import { canonicalInstanceId, rejectUnownedInstance } from "@/lib/auth/instance-ownership";
import { prisma } from "@/lib/prisma";
import { stopInstance } from "@/lib/hostedai";
import { instanceProductName, logGPUStopped } from "@/lib/activity";

// POST - Stop an instance
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAuthenticatedCustomer(request);
    if (auth instanceof NextResponse) return auth;
    const { payload, allTeamIds } = auth;

    if (!allTeamIds.length) {
      return NextResponse.json({ error: "No team associated with this account" }, { status: 400 });
    }

    const id = canonicalInstanceId((await params).id);

    // PA-175 gate: stopping a shared instance is an authoritative state change.
    const denial = requirePermission(auth, "gpu.terminate", request, { instanceId: id, action: "stop" });
    if (denial) return denial;
    console.log("[HAI 2.2] Stopping instance:", id);

    const notOwned = await rejectUnownedInstance(allTeamIds, id);
    if (notOwned) return notOwned;

    await stopInstance(id);

    let displayNameForLog: string | undefined;
    let productIdForLog: string | null | undefined;
    try {
      const meta = await prisma.podMetadata.findFirst({
        where: { OR: [{ instanceId: id }, { subscriptionId: id }] },
        select: { displayName: true, productId: true },
      });
      displayNameForLog = meta?.displayName || undefined;
      productIdForLog = meta?.productId;
    } catch { /* ignore */ }
    await logGPUStopped(payload.customerId, await instanceProductName(productIdForLog), displayNameForLog, id);

    return NextResponse.json({
      success: true,
      instance_id: id,
      message: "GPU stopped successfully",
    });
  } catch (error) {
    console.error("Stop instance error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to stop instance" },
      { status: 500 }
    );
  }
}
