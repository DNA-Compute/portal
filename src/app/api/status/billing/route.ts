import { NextResponse } from "next/server";
import { getBillingHealth } from "@/lib/billing-heartbeat";

export const dynamic = "force-dynamic";

/**
 * GET /api/status/billing
 *
 * For an outside uptime check: 200 while billing runs on time without GPU errors, 503 otherwise.
 * Shows only when billing last finished and how many GPUs failed, nothing about customers.
 */
export async function GET() {
  try {
    const health = await getBillingHealth();
    return NextResponse.json(health, {
      status: health.ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[Billing health] Check failed:", error);
    return NextResponse.json({ ok: false, reason: "check_failed" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
