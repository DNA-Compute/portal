import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import { requirePermission } from "@/lib/auth/audit";
import { getStoppedInstanceRatePercent } from "@/lib/pricing";
import { getWalletTransactions, isUserFacingWalletTransaction } from "@/lib/wallet";

// GET - Get billing statistics for a customer
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedCustomer(request);
    if (auth instanceof NextResponse) return auth;
    const { customer } = auth;

    // PA-202 gate: billing.view required (Team Admin + Finance Manager allowed,
    // Team Member + Read-only Member denied).
    const denial = requirePermission(auth, "billing.view", request);
    if (denial) return denial;

    // Wallet charges are retail USD debits recorded this UTC month, not native costs.
    const now = new Date();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
    const periodStartSeconds = Math.floor(startOfMonth.getTime() / 1000);
    const periodEndSeconds = Math.floor(now.getTime() / 1000);
    const chartStartSeconds = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 13) / 1000;
    const transactions = await getWalletTransactions(customer.id, 0, Math.min(periodStartSeconds, chartStartSeconds));
    const dailyCharges = Array.from({ length: 14 }, (_, index) => ({
      date: new Date((chartStartSeconds + index * 86400) * 1000).toISOString().slice(0, 10),
      amountCents: 0,
    }));

    let totalCostCents = 0;
    let storageCostCents = 0;
    // GPU time the customer was billed for, from the wallet ledger. hosted.ai's usage report lists
    // instances with every usage field "0", so it cannot be used for this.
    let gpuMinutes = 0;
    for (const txn of transactions) {
      if (txn.created >= periodStartSeconds && txn.created <= periodEndSeconds) gpuMinutes += billedGpuMinutes(txn);
      if (txn.created > periodEndSeconds || !isUserFacingWalletTransaction(txn) || txn.amount <= 0) continue;
      if (txn.currency !== "usd") {
        throw new Error(`Unsupported wallet charge currency: ${txn.currency}`);
      }
      if (txn.created >= periodStartSeconds) {
        totalCostCents += txn.amount;
        if (txn.metadata?.billing_type === "storage") storageCostCents += txn.amount;
      }
      const dayIndex = Math.floor((txn.created - chartStartSeconds) / 86400);
      if (dayIndex >= 0 && dayIndex < dailyCharges.length) dailyCharges[dayIndex].amountCents += txn.amount;
    }

    return NextResponse.json({
      totalCost: totalCostCents / 100,
      gpuHours: Math.max(0, gpuMinutes) / 60,
      storageCost: storageCostCents / 100,
      dailyCharges,
      periodStart: startOfMonth.toISOString(),
      periodEnd: now.toISOString(),
      // Pricing configuration for UI
      // Note: hourlyRateCents removed - GPU rates now vary per product (GpuProduct model)
      stoppedInstanceRatePercent: getStoppedInstanceRatePercent(),
    });
  } catch (error) {
    console.error("Billing stats error:", error);
    return NextResponse.json(
      { error: "Failed to get billing stats" },
      { status: 500 }
    );
  }
}

/**
 * Minutes of GPU time one ledger entry adds (launch and usage charges) or gives back (unused-time credits).
 * shortcut: a failed launch's refund records no minutes, so its launch block still counts here.
 */
function billedGpuMinutes(txn: { metadata?: Record<string, string> | null }): number {
  const meta = txn.metadata ?? {};
  if (meta.billing_type === "gpu_usage") return Number(meta.billing_minutes) || 0;
  if (meta.hours_used !== undefined) return (Number(meta.hours_used) || 0) * 60;
  if (meta.unused_minutes !== undefined) return -(Number(meta.unused_minutes) || 0);
  return 0;
}
