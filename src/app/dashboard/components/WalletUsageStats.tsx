"use client";

import type { BillingStats } from "./types";

export function WalletUsageStats({ stats, error }: { stats: BillingStats | null; error: string | null }) {
  const current = error ? null : stats;
  const status = error ? "Unavailable" : "Loading…";
  const asOf = current?.periodEnd ? new Date(current.periodEnd) : null;
  const projectedCharges = current && asOf && Number.isFinite(asOf.getTime())
    ? current.totalCost / asOf.getUTCDate() * new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() + 1, 0)).getUTCDate()
    : null;

  return (
    <>
      <div role="group" aria-label="GPU hours" className="bg-white rounded-2xl p-5 border border-[var(--line)]">
        <div className="text-xs text-[var(--muted)] mb-1">GPU Hours</div>
        <div className="text-3xl font-bold text-[var(--fg)]">{current ? `${current.gpuHours.toFixed(2)}h` : "—"}</div>
        <div className="text-xs text-zinc-400">{current ? "Provider usage · this month (UTC)" : status}</div>
      </div>

      <div role="group" aria-label="Wallet charges" className="bg-white rounded-2xl p-5 border border-[var(--line)]">
        <div className="text-xs text-[var(--muted)] mb-1">Wallet charges</div>
        <div className="text-3xl font-bold text-[var(--fg)]">{current ? `$${current.totalCost.toFixed(2)}` : "—"}</div>
        <div className="text-xs text-zinc-400">
          {current ? (current.storageCost > 0
            ? `$${current.storageCost.toFixed(2)} storage + $${(current.totalCost - current.storageCost).toFixed(2)} other charges`
            : "This month (UTC)") : status}
        </div>
        <div className="text-xs text-zinc-400">Subscription payments and credits are separate.</div>
      </div>

      <div role="group" aria-label="Projected wallet charges" className="bg-white rounded-2xl p-5 border border-[var(--line)]">
        <div className="text-xs text-[var(--muted)] mb-1">Projected wallet charges</div>
        <div className="text-3xl font-bold text-[var(--fg)]">{projectedCharges === null ? "—" : `~$${projectedCharges.toFixed(0)}`}</div>
        <div className="text-xs text-zinc-400">{current ? "At this month's pace (UTC)" : status}</div>
      </div>
    </>
  );
}
