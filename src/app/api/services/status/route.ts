import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { resolveOperatingContext } from "@/lib/auth/account-resolver";
import { rejectUnownedInstance } from "@/lib/auth/instance-ownership";
import { getExposeServiceStatus } from "@/lib/hostedai";

// GET - Check service exposure status
export async function GET(request: NextRequest) {
  try {
    // Verify customer auth
    const authHeader = request.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const token = authHeader.slice(7);
    const payload = verifyCustomerToken(token);
    if (!payload) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const serviceName = searchParams.get("serviceName");
    const poolSubscriptionId = searchParams.get("poolSubscriptionId");
    const operationId = searchParams.get("operationId");

    if (!serviceName || !poolSubscriptionId) {
      return NextResponse.json(
        { error: "serviceName and poolSubscriptionId are required" },
        { status: 400 }
      );
    }

    const ctx = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });
    if (!ctx) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    const notOwned = await rejectUnownedInstance(ctx.allTeamIds, poolSubscriptionId);
    if (notOwned) return notOwned;

    const status = await getExposeServiceStatus(
      serviceName,
      Number(poolSubscriptionId),
      operationId || undefined
    );

    return NextResponse.json({ status });
  } catch (error) {
    console.error("Failed to get service status:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Failed to get service status";
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
