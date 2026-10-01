import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import { requirePermission } from "@/lib/auth/audit";
import { getTeamBillingSummaryV2, formatBillingDatetime } from "@/lib/hostedai";
import { getStoppedInstanceRatePercent } from "@/lib/pricing";
import { getWalletTransactions, isUserFacingWalletTransaction } from "@/lib/wallet";

// GET - Get billing statistics for a customer
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedCustomer(request);
    if (auth instanceof NextResponse) return auth;
    const { customer, teamId } = auth;

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
    for (const txn of transactions) {
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

    let gpuHours = 0;
    let storageHours = 0;
    if (teamId) {
      try {
        // Provider data supplies usage quantities only, never retail money.
        const billing = await getTeamBillingSummaryV2(
          teamId,
          formatBillingDatetime(startOfMonth),
          formatBillingDatetime(now)
        );

        let poolHours = 0;
        if (Array.isArray(billing.gpuaas_summary)) {
          poolHours = billing.gpuaas_summary.reduce((sum: number, item: { pool_hours?: number }) => {
            return sum + (Number(item.pool_hours) || 0);
          }, 0);
        }

        let instanceHours = 0;
        if (Array.isArray(billing.instance_billing_summary)) {
          instanceHours = billing.instance_billing_summary.reduce((sum: number, item: { hours?: number }) => {
            return sum + (Number(item.hours) || 0);
          }, 0);
        }

        if (Array.isArray(billing.shared_storage_billing_summary)) {
          for (const storage of billing.shared_storage_billing_summary) {
            storageHours += Number(storage.hours) || 0;
          }
        }

        // Preserve provider quantity fallbacks; never estimate hours from dollars.
        if (poolHours === 0) poolHours = Number(billing.pool_hours) || 0;
        if (instanceHours === 0) instanceHours = Number(billing.instance_hours) || 0;
        gpuHours = Number(billing.total_hours) || poolHours + instanceHours;
      } catch (error) {
        console.error("Failed to fetch billing summary:", error);
        // Optional usage quantities must not hide successfully loaded retail wallet charges.
      }
    }

    return NextResponse.json({
      totalCost: totalCostCents / 100,
      gpuHours,
      storageCost: storageCostCents / 100,
      storageHours,
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
