import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import { getActivityEvents, type ActivityEventType } from "@/lib/activity";

// Hidden from members who can't see billing, as the dashboard hides the wallet and payments.
const BILLING_EVENTS = new Set<ActivityEventType>([
  "payment_received",
  "wallet_charged",
  "wallet_topup",
  "voucher_redeemed",
  "budget_set",
]);

// GET - Get activity events for the account being worked in
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedCustomer(request);
    if (auth instanceof NextResponse) return auth;

    // Get limit from query params
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get("limit") || "50", 10);

    const events = await getActivityEvents(auth.accountId, limit);

    return NextResponse.json({
      events: auth.can("billing.view") ? events : events.filter((e) => !BILLING_EVENTS.has(e.type)),
    });
  } catch (error) {
    console.error("Get activity error:", error);
    return NextResponse.json(
      { error: "Failed to get activity" },
      { status: 500 }
    );
  }
}
