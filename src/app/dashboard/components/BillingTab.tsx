"use client";

import { useState, useMemo, useEffect } from "react";
import { UsageChart } from "./UsageChart";
import type { BillingStats } from "./types";

interface Transaction {
  id: string;
  amount: number;
  amountFormatted: string;
  description: string;
  created: number;
  type: "credit" | "debit";
}

interface Payment {
  id: string;
  amount: number;
  amountFormatted: string;
  created: number;
  description: string;
  invoicePdf?: string | null;
}

interface Subscription {
  id: string;
  status: string;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  productName: string | null;
  pricePerMonthCents: number | null;
}

interface AllTimeStats {
  totalSpent: number;
  totalCredits: number;
  transactionCount: number;
}

interface BillingTabProps {
  billingStats: BillingStats | null;
  billingStatsError: string | null;
  walletBalance: string;
  onTopUp: () => void;
  formatDateTime: (timestamp: number) => string;
  onDownloadCSV: () => void;
  payments?: Payment[];
  billingPortalUrl?: string;
  subscriptions?: Subscription[];
  token: string;
}

type PeriodType = "day" | "week" | "month" | "year" | "all";
type FilterType = "all" | "credits" | "debits";

export function BillingTab({
  billingStats,
  billingStatsError,
  walletBalance,
  onTopUp,
  formatDateTime,
  onDownloadCSV,
  payments = [],
  billingPortalUrl,
  subscriptions = [],
  token,
}: BillingTabProps) {
  const [period, setPeriod] = useState<PeriodType>("all");
  const [filter, setFilter] = useState<FilterType>("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Every period report uses complete wallet history, never the account preview page.
  const [history, setHistory] = useState<{
    token: string;
    data: { transactions: Transaction[]; allTimeStats: AllTimeStats } | null;
    error: string | null;
  } | null>(null);
  const currentHistory = history?.token === token ? history : null;
  const historyData = currentHistory?.data;
  const historyStatus = currentHistory?.error ?? "Loading wallet history…";
  const transactions = useMemo(() => historyData?.transactions ?? [], [historyData]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/billing/history", {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async response => {
        if (!response.ok) throw new Error(`Wallet history returned ${response.status}`);
        const data: { transactions: Transaction[]; allTimeStats: AllTimeStats } = await response.json();
        if (!Array.isArray(data.transactions) || !data.allTimeStats) throw new Error("Incomplete wallet history");
        if (!controller.signal.aborted) setHistory({ token, data, error: null });
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        console.error("[BillingTab] Failed to fetch wallet history:", error);
        setHistory({ token, data: null, error: "Wallet history is unavailable." });
      });
    return () => controller.abort();
  }, [token]);

  // Calculate period boundaries
  const periodBoundaries = useMemo(() => {
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setUTCDate(startOfWeek.getUTCDate() - startOfWeek.getUTCDay());
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));

    return {
      day: startOfDay.getTime(),
      week: startOfWeek.getTime(),
      month: startOfMonth.getTime(),
      year: startOfYear.getTime(),
      all: 0,
    };
  }, []);

  // Filter transactions by period, type, and search
  const filteredTransactions = useMemo(() => {
    // periodBoundaries are in milliseconds (from getTime())
    // txn.created is in seconds (Unix timestamp from Stripe)
    // Convert periodStart to seconds for comparison
    const periodStartSeconds = periodBoundaries[period] / 1000;

    return transactions.filter((txn) => {
      // Period filter - both now in seconds
      if (txn.created < periodStartSeconds) return false;

      // Type filter
      if (filter === "credits" && txn.type !== "credit") return false;
      if (filter === "debits" && txn.type !== "debit") return false;

      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        if (!txn.description.toLowerCase().includes(query)) return false;
      }

      return true;
    });
  }, [transactions, period, filter, searchQuery, periodBoundaries]);

  // Calculate statistics for filtered transactions
  const stats = useMemo(() => {
    let totalCredits = 0;
    let totalDebits = 0;
    for (const txn of filteredTransactions) {
      const amount = Math.abs(txn.amount) / 100;
      if (txn.type === "credit") totalCredits += amount;
      else totalDebits += amount;
    }
    return { totalCredits, totalDebits, transactionCount: filteredTransactions.length };
  }, [filteredTransactions]);


  // Calculate total card payments
  const totalPaid = useMemo(() => {
    return payments.reduce((sum, p) => sum + p.amount, 0) / 100;
  }, [payments]);

  // Group transactions by date for the list
  // Note: txn.created is in seconds (Unix timestamp), multiply by 1000 for Date()
  const groupedTransactions = useMemo(() => {
    const groups: Record<string, Transaction[]> = {};

    filteredTransactions.forEach((txn) => {
      const date = new Date(txn.created * 1000).toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });

      if (!groups[date]) {
        groups[date] = [];
      }
      groups[date].push(txn);
    });

    return Object.entries(groups).sort(([a], [b]) => {
      const txnA = filteredTransactions.find((t) =>
        new Date(t.created * 1000).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }) === a
      );
      const txnB = filteredTransactions.find((t) =>
        new Date(t.created * 1000).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }) === b
      );
      return (txnB?.created || 0) - (txnA?.created || 0);
    });
  }, [filteredTransactions]);

  const periodLabels: Record<PeriodType, string> = {
    day: "Today",
    week: "This Week",
    month: "This Month",
    year: "This Year",
    all: "All Time",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[var(--fg)]">Billing</h1>
        <div className="flex items-center gap-3">
          <button
            onClick={onDownloadCSV}
            className="flex items-center gap-2 px-4 py-2 text-sm text-zinc-600 hover:text-zinc-800 bg-zinc-100 hover:bg-zinc-200 rounded-xl transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Export CSV
          </button>
          <button
            onClick={onTopUp}
            className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-violet-600 hover:bg-violet-700 rounded-xl transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Top Up
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-white rounded-2xl p-5 border border-[var(--line)]">
          <div className="text-xs text-[var(--muted)] mb-1">Current Balance</div>
          <div className="text-2xl font-bold text-[var(--fg)]">{walletBalance}</div>
        </div>

        <div role="group" aria-label="All-time wallet charges" className="bg-white rounded-2xl p-5 border border-[var(--line)]">
          <div className="text-xs text-[var(--muted)] mb-1">All-Time Wallet Charges</div>
          <div className="text-2xl font-bold text-[var(--fg)]">
            {historyData ? `$${historyData.allTimeStats.totalSpent.toFixed(2)}` : "—"}
          </div>
          <div className="text-xs text-zinc-400">
            {historyData ? `$${historyData.allTimeStats.totalCredits.toFixed(2)} credits shown separately` : historyStatus}
          </div>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-[var(--line)]">
          <div className="text-xs text-[var(--muted)] mb-1">Total Transactions</div>
          <div className="text-2xl font-bold text-[var(--fg)]">{historyData ? stats.transactionCount : "—"}</div>
          <div className="text-xs text-zinc-400">{historyData ? `${periodLabels[period]} (UTC)` : historyStatus}</div>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-[var(--line)]">
          <div className="text-xs text-[var(--muted)] mb-1">Period Wallet Charges</div>
          <div className="text-2xl font-bold text-[var(--fg)]">{historyData ? `$${stats.totalDebits.toFixed(2)}` : "—"}</div>
          <div className="text-xs text-zinc-400">{historyData ? "Selected period and filters (UTC)" : historyStatus}</div>
        </div>

        <div className="bg-white rounded-2xl p-5 border border-[var(--line)]">
          <div className="text-xs text-[var(--muted)] mb-1">Card Payments Shown</div>
          <div className="text-2xl font-bold text-emerald-600">${totalPaid.toFixed(2)}</div>
          <div className="text-xs text-zinc-400">{payments.length} recent payment{payments.length !== 1 ? "s" : ""}</div>
        </div>
      </div>

      {/* Active Subscriptions */}
      {subscriptions.length > 0 && (
        <div className="bg-white rounded-2xl border border-[var(--line)] overflow-hidden">
          <div className="px-6 py-4 border-b border-[var(--line)] flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-[var(--fg)]">Active Subscriptions</h3>
              <p className="text-xs text-zinc-400 mt-1">Your monthly GPU subscriptions</p>
            </div>
            {billingPortalUrl && (
              <a
                href={billingPortalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-4 py-2 text-sm text-teal-600 hover:text-teal-800 bg-teal-50 hover:bg-teal-100 rounded-xl transition-colors font-medium"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Manage Subscriptions
              </a>
            )}
          </div>
          <div className="divide-y divide-zinc-100">
            {subscriptions.map((sub) => (
              <div
                key={sub.id}
                className="flex items-center justify-between px-6 py-4 hover:bg-zinc-50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    sub.cancelAtPeriodEnd ? "bg-amber-100" : "bg-teal-100"
                  }`}>
                    <svg className={`w-4 h-4 ${sub.cancelAtPeriodEnd ? "text-amber-600" : "text-teal-600"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm text-zinc-700 font-medium">
                      {sub.productName || "GPU Subscription"}
                    </p>
                    <p className="text-xs text-zinc-400">
                      {sub.cancelAtPeriodEnd
                        ? `Cancels ${new Date(sub.currentPeriodEnd * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`
                        : `Renews ${new Date(sub.currentPeriodEnd * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`
                      }
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {sub.pricePerMonthCents && (
                    <span className="text-sm font-mono text-zinc-700">
                      ${(sub.pricePerMonthCents / 100).toFixed(0)}/mo
                    </span>
                  )}
                  {sub.cancelAtPeriodEnd ? (
                    <span className="px-2 py-1 text-xs font-medium text-amber-700 bg-amber-100 rounded-lg">
                      Cancelling
                    </span>
                  ) : (
                    <span className="px-2 py-1 text-xs font-medium text-teal-700 bg-teal-100 rounded-lg">
                      Active
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Card Payments */}
      {payments.length > 0 && (
        <div className="bg-white rounded-2xl border border-[var(--line)] overflow-hidden">
          <div className="px-6 py-4 border-b border-[var(--line)]">
            <h3 className="font-semibold text-[var(--fg)]">Card Payments</h3>
            <p className="text-xs text-zinc-400 mt-1">Actual charges to your payment method</p>
          </div>
          <div className="divide-y divide-zinc-100">
            {payments.map((payment) => (
              <div
                key={payment.id}
                className="flex items-center justify-between px-6 py-4 hover:bg-zinc-50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center">
                    <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm text-zinc-700">{payment.description}</p>
                    <p className="text-xs text-zinc-400">
                      {new Date(payment.created * 1000).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-mono text-emerald-600">
                    {payment.amountFormatted}
                  </span>
                  {payment.invoicePdf && (
                    <a
                      href={payment.invoicePdf}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 px-2 py-1 text-xs text-zinc-500 hover:text-violet-600 bg-zinc-100 hover:bg-violet-50 rounded-lg transition-colors"
                      title="Download invoice PDF"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      Invoice
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Spend Chart */}
      <div className="bg-white rounded-2xl border border-[var(--line)] p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-[var(--fg)]">Wallet Charges Over Time</h3>
          <span className="text-xs text-zinc-400">Last 14 days (UTC)</span>
        </div>
        <div className="h-48">
          <UsageChart charges={billingStats?.dailyCharges ?? null} error={billingStatsError} />
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4">
        {/* Period Selector */}
        <div className="flex items-center gap-1 bg-zinc-100 rounded-xl p-1">
          {(["day", "week", "month", "year", "all"] as PeriodType[]).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                period === p
                  ? "bg-white text-[var(--fg)] shadow-sm"
                  : "text-zinc-500 hover:text-zinc-700"
              }`}
            >
              {p === "day" ? "Day" : p === "week" ? "Week" : p === "month" ? "Month" : p === "year" ? "Year" : "All"}
            </button>
          ))}
        </div>

        {/* Type Filter */}
        <div className="flex items-center gap-1 bg-zinc-100 rounded-xl p-1">
          {(["all", "debits", "credits"] as FilterType[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                filter === f
                  ? "bg-white text-[var(--fg)] shadow-sm"
                  : "text-zinc-500 hover:text-zinc-700"
              }`}
            >
              {f === "all" ? "All" : f === "debits" ? "Charges" : "Credits"}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="flex-1">
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search transactions..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-zinc-100 border-0 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </div>
        </div>
      </div>

      {/* Transactions List */}
      <div className="bg-white rounded-2xl border border-[var(--line)] overflow-hidden">
        <div className="px-6 py-4 border-b border-[var(--line)] flex items-center justify-between">
          <h3 className="font-semibold text-[var(--fg)]">
            Transactions
            <span className="ml-2 text-sm font-normal text-zinc-400">
              {historyData ? `(${filteredTransactions.length} of ${transactions.length})` : "—"}
            </span>
          </h3>
          {filteredTransactions.length > 0 && (
            <div className="text-sm text-zinc-500">
              Total: <span className="font-mono text-zinc-700">${stats.totalDebits.toFixed(2)}</span>
              {stats.totalCredits > 0 && (
                <span className="text-emerald-600 ml-2">+${stats.totalCredits.toFixed(2)}</span>
              )}
            </div>
          )}
        </div>

        {filteredTransactions.length > 0 ? (
          <div className="max-h-[500px] overflow-y-auto">
            {groupedTransactions.map(([date, txns]) => (
              <div key={date}>
                <div className="sticky top-0 px-6 py-2 bg-zinc-50 border-b border-zinc-100">
                  <span className="text-xs font-medium text-zinc-500">{date}</span>
                  <span className="ml-2 text-xs text-zinc-400">
                    ({txns.length} transaction{txns.length !== 1 ? "s" : ""})
                  </span>
                </div>
                <div className="divide-y divide-zinc-100">
                  {txns.map((txn) => (
                    <div
                      key={txn.id}
                      className="flex items-center justify-between px-6 py-4 hover:bg-zinc-50 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-8 h-8 rounded-full flex items-center justify-center ${
                            txn.type === "credit" ? "bg-emerald-100" : "bg-zinc-100"
                          }`}
                        >
                          {txn.type === "credit" ? (
                            <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                            </svg>
                          ) : (
                            <svg className="w-4 h-4 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                            </svg>
                          )}
                        </div>
                        <div>
                          <p className="text-sm text-zinc-700">{txn.description}</p>
                          <p className="text-xs text-zinc-400">
                            {new Date(txn.created * 1000).toLocaleTimeString("en-US", {
                              hour: "numeric",
                              minute: "2-digit",
                              hour12: true,
                            })}
                          </p>
                        </div>
                      </div>
                      <span
                        className={`text-sm font-mono ${
                          txn.type === "credit" ? "text-emerald-600" : "text-zinc-600"
                        }`}
                      >
                        {txn.type === "credit" ? "+" : "−"}{txn.amountFormatted}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : !historyData ? (
          <div role="status" className="px-6 py-16 text-center text-zinc-500 text-sm">{historyStatus}</div>
        ) : (
          <div className="px-6 py-16 text-center">
            <div className="w-12 h-12 bg-zinc-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-zinc-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <p className="text-zinc-500 text-sm">
              {searchQuery
                ? "No transactions match your search"
                : `No transactions ${period !== "all" ? periodLabels[period].toLowerCase() : ""}`}
            </p>
            {(searchQuery || filter !== "all" || period !== "all") && (
              <button
                onClick={() => {
                  setSearchQuery("");
                  setFilter("all");
                  setPeriod("all");
                }}
                className="mt-2 text-sm text-violet-600 hover:text-violet-700"
              >
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
