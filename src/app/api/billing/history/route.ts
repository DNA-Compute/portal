import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import { requirePermission } from "@/lib/auth/audit";
import { getWalletTransactions, formatCentsForUser, isUserFacingWalletTransaction } from "@/lib/wallet";

/**
 * GET /api/billing/history
 *
 * Returns the complete Stripe balance transaction history for the authenticated
 * customer, auto-paginating all pages regardless of count.
 *
 * Also returns pre-computed all-time aggregate totals so the dashboard can display
 * accurate "All-Time Spend" stats without the 100-transaction cap imposed by the
 * fast-path in /api/account/verify.
 *
 * Used by:
 *   - BillingTab.tsx  — lazy-loads all-time stats on mount
 *   - downloadTransactionsCSV — exports the complete transaction history
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedCustomer(request);
    if (auth instanceof NextResponse) return auth;

    // PA-269: billing.view required — same gate as /api/account/billing-stats.
    // Previously this route only verified the JWT was valid, so any Team Member
    // or Read-only Member could read the owner's full transaction history +
    // all-time spend by calling it directly. The sidebar hide was cosmetic.
    const denial = requirePermission(auth, "billing.view", request);
    if (denial) return denial;

    // auth.payload.customerId is the Stripe customer ID baked into the JWT at
    // login time. For team members this is the owner's customer ID — the same
    // wallet this route read before the gate was added (no data-selection change).
    const allRaw = await getWalletTransactions(auth.payload.customerId);

    const userFacing = allRaw.filter(isUserFacingWalletTransaction);

    // Compute all-time aggregates from the raw Stripe amounts:
    // positive amount = debit (customer spent), negative = credit (customer received)
    let totalSpentCents = 0;
    let totalCreditsCents = 0;
    for (const txn of userFacing) {
      if (txn.amount > 0) {
        totalSpentCents += txn.amount;
      } else {
        totalCreditsCents += Math.abs(txn.amount);
      }
    }

    const transactions = userFacing.map((txn) => ({
      id: txn.id,
      amount: Math.abs(txn.amount),
      amountFormatted: formatCentsForUser(Math.abs(txn.amount)),
      description: txn.description || "Transaction",
      created: txn.created,
      type: txn.amount < 0 ? ("credit" as const) : ("debit" as const),
    }));

    return NextResponse.json({
      transactions,
      allTimeStats: {
        totalSpent: totalSpentCents / 100,
        totalCredits: totalCreditsCents / 100,
        netSpend: (totalSpentCents - totalCreditsCents) / 100,
        transactionCount: transactions.length,
      },
    });
  } catch (error) {
    console.error("[BillingHistory] Error fetching full transaction history:", error);
    return NextResponse.json(
      { error: "Failed to fetch billing history" },
      { status: 500 }
    );
  }
}
