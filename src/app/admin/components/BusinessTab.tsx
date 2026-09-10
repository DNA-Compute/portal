"use client";

import { useState, useEffect, useCallback } from "react";

interface DailyData {
  date: string;
  revenue: number;
  deposits: number;
}

interface DailySignups {
  date: string;
  count: number;
}

interface CustomerInfo {
  id: string;
  email: string;
  name: string;
  balance?: number;
  spent?: number;
  created?: number;
}

interface BusinessMetrics {
  period: string;
  periodDays: number;
  cachedAt?: string;
  revenue: {
    total: number;
    previous: number;
    change: number;
    refunds: number;
    daily: DailyData[];
  };
  customers: {
    total: number;
    new: number;
    previousNew: number;
    change: number;
    active: number;
    hourly: number;
    monthly: number;
    avgValue: number;
    dailySignups: DailySignups[];
  };
  wallet: {
    totalBalance: number;
    avgBalance: number;
  };
  gpu: {
    activeGPUs: number;
    activePods: number;
    totalHoursUsed: number;
    totalUsageCost: number;
    avgUtilization: number;
  };
  providers: {
    total: number;
    active: number;
    totalNodes: number;
    activeNodes: number;
    payouts: number;
    revenue: number;
    earnings: number;
    margin: number;
  };
  marketing: {
    voucherRedemptions: number;
    voucherCreditsGiven: number;
    referralClaims: number;
    referralConversions: number;
    activeVouchers: number;
    activeReferralCodes: number;
  };
  topCustomers: {
    byBalance: CustomerInfo[];
    bySpending: CustomerInfo[];
  };
}

type DrillDownType = "revenue" | "customers" | "gpu" | "providers" | "marketing" | "topCustomers" | null;

export function BusinessTab() {
  const [metrics, setMetrics] = useState<BusinessMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState("30d");
  const [drillDown, setDrillDown] = useState<DrillDownType>(null);

  const fetchMetrics = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ period });
      if (refresh) params.set("refresh", "true");
      const res = await fetch(`/api/admin/business-metrics?${params}`);
      const data = await res.json();
      if (data.success) {
        setMetrics(data);
      } else {
        setError(data.error || "Failed to load metrics");
      }
    } catch (err) {
      setError("Failed to fetch business metrics");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetchMetrics();
  }, [fetchMetrics]);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatNumber = (value: number) => {
    return new Intl.NumberFormat("en-US").format(value);
  };

  const formatPercent = (value: number) => {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(1)}%`;
  };

  const ChangeIndicator = ({ value }: { value: number }) => (
    <span className={`text-sm font-medium ${value >= 0 ? "text-emerald-600" : "text-red-600"}`}>
      {formatPercent(value)}
    </span>
  );

  // Simple bar chart component
  const MiniBarChart = <T extends { date: string }>({
    data,
    getValue,
    formatValue,
    maxValue
  }: {
    data: T[];
    getValue: (d: T) => number;
    formatValue?: (v: number) => string;
    maxValue?: number;
  }) => {
    const max = maxValue || Math.max(...data.map(getValue), 1);
    const format = formatValue || ((v: number) => String(v));
    return (
      <div className="flex items-end gap-1 h-16">
        {data.slice(-14).map((d, i) => {
          const value = getValue(d);
          const height = (value / max) * 100;
          return (
            <div
              key={i}
              className="flex-1 bg-[var(--acid)] rounded-t hover:bg-[var(--acid-deep)] transition-colors cursor-pointer group relative"
              style={{ height: `${Math.max(height, 2)}%` }}
              title={`${d.date}: ${format(value)}`}
            >
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 bg-gray-50 text-white text-xs rounded opacity-0 group-hover:opacity-100 whitespace-nowrap z-10">
                {d.date}: {format(value)}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin h-8 w-8 border-2 border-[var(--acid)] border-t-transparent rounded-full"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
        {error}
        <button onClick={() => fetchMetrics()} className="ml-4 text-sm underline">
          Retry
        </button>
      </div>
    );
  }

  if (!metrics) return null;

  return (
    <div className="space-y-6">
      {/* Period Selector */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-[var(--fg)]">Business Metrics</h2>
        <div className="flex gap-2">
          {["7d", "30d", "90d"].map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                period === p
                  ? "bg-[var(--acid)] text-white"
                  : "bg-white border border-[var(--line)] text-[var(--fg-muted)] hover:bg-gray-50"
              }`}
            >
              {p === "7d" ? "7 Days" : p === "30d" ? "30 Days" : "90 Days"}
            </button>
          ))}
          <button
            onClick={() => fetchMetrics(true)}
            className="px-3 py-1.5 text-sm bg-white border border-[var(--line)] text-[var(--fg-muted)] hover:bg-gray-50 rounded-lg"
          >
            Refresh
          </button>
          {metrics?.cachedAt && (
            <span className="text-xs text-[var(--fg-muted)] self-center">
              Updated {new Date(metrics.cachedAt).toLocaleString()}
            </span>
          )}
        </div>
      </div>

      {/* Key Metrics Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Revenue */}
        <div
          className="bg-white rounded-xl border border-[var(--line)] p-4 cursor-pointer hover:border-[var(--acid)] transition-colors"
          onClick={() => setDrillDown("revenue")}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-[var(--fg-muted)]">Revenue</span>
            <ChangeIndicator value={metrics.revenue.change} />
          </div>
          <p className="text-2xl font-bold text-[var(--fg)]">{formatCurrency(metrics.revenue.total)}</p>
          <p className="text-xs text-[var(--fg-muted)] mt-1">vs {formatCurrency(metrics.revenue.previous)} prev</p>
        </div>

        {/* New Customers */}
        <div
          className="bg-white rounded-xl border border-[var(--line)] p-4 cursor-pointer hover:border-[var(--acid)] transition-colors"
          onClick={() => setDrillDown("customers")}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-[var(--fg-muted)]">New Customers</span>
            <ChangeIndicator value={metrics.customers.change} />
          </div>
          <p className="text-2xl font-bold text-[var(--fg)]">{metrics.customers.new}</p>
          <p className="text-xs text-[var(--fg-muted)] mt-1">{metrics.customers.total} total</p>
        </div>

        {/* Active GPUs */}
        <div
          className="bg-white rounded-xl border border-[var(--line)] p-4 cursor-pointer hover:border-[var(--acid)] transition-colors"
          onClick={() => setDrillDown("gpu")}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-[var(--fg-muted)]">Active GPUs</span>
            <span className="text-sm text-emerald-600">{metrics.gpu.avgUtilization.toFixed(0)}% util</span>
          </div>
          <p className="text-2xl font-bold text-[var(--fg)]">{metrics.gpu.activeGPUs}</p>
          <p className="text-xs text-[var(--fg-muted)] mt-1">{metrics.gpu.activePods} active pods</p>
        </div>

        {/* Wallet Balance */}
        <div
          className="bg-white rounded-xl border border-[var(--line)] p-4 cursor-pointer hover:border-[var(--acid)] transition-colors"
          onClick={() => setDrillDown("topCustomers")}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-[var(--fg-muted)]">Wallet Balance</span>
          </div>
          <p className="text-2xl font-bold text-emerald-600">{formatCurrency(metrics.wallet.totalBalance)}</p>
          <p className="text-xs text-[var(--fg-muted)] mt-1">{formatCurrency(metrics.wallet.avgBalance)} avg</p>
        </div>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue Chart */}
        <div className="bg-white rounded-xl border border-[var(--line)] p-6">
          <h3 className="font-semibold text-[var(--fg)] mb-4">Daily Revenue</h3>
          <MiniBarChart data={metrics.revenue.daily} getValue={(d) => d.revenue} formatValue={formatCurrency} />
          <div className="flex justify-between mt-2 text-xs text-[var(--fg-muted)]">
            <span>{metrics.revenue.daily[0]?.date}</span>
            <span>{metrics.revenue.daily[metrics.revenue.daily.length - 1]?.date}</span>
          </div>
        </div>

        {/* Signups Chart */}
        <div className="bg-white rounded-xl border border-[var(--line)] p-6">
          <h3 className="font-semibold text-[var(--fg)] mb-4">Daily Signups</h3>
          <MiniBarChart data={metrics.customers.dailySignups} getValue={(d) => d.count} />
          <div className="flex justify-between mt-2 text-xs text-[var(--fg-muted)]">
            <span>{metrics.customers.dailySignups[0]?.date}</span>
            <span>{metrics.customers.dailySignups[metrics.customers.dailySignups.length - 1]?.date}</span>
          </div>
        </div>
      </div>

      {/* Secondary Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Provider Metrics */}
        <div
          className="bg-white rounded-xl border border-[var(--line)] p-4 cursor-pointer hover:border-[var(--acid)] transition-colors"
          onClick={() => setDrillDown("providers")}
        >
          <span className="text-sm text-[var(--fg-muted)]">Providers</span>
          <p className="text-xl font-bold text-[var(--fg)] mt-1">{metrics.providers.active} active</p>
          <p className="text-xs text-[var(--fg-muted)]">{metrics.providers.activeNodes} nodes</p>
        </div>

        {/* GPU Hours */}
        <div className="bg-white rounded-xl border border-[var(--line)] p-4">
          <span className="text-sm text-[var(--fg-muted)]">GPU Hours Used</span>
          <p className="text-xl font-bold text-[var(--fg)] mt-1">{formatNumber(metrics.gpu.totalHoursUsed)}</p>
          <p className="text-xs text-[var(--fg-muted)]">{formatCurrency(metrics.gpu.totalUsageCost)} cost</p>
        </div>

        {/* Marketing */}
        <div
          className="bg-white rounded-xl border border-[var(--line)] p-4 cursor-pointer hover:border-[var(--acid)] transition-colors"
          onClick={() => setDrillDown("marketing")}
        >
          <span className="text-sm text-[var(--fg-muted)]">Vouchers Redeemed</span>
          <p className="text-xl font-bold text-[var(--fg)] mt-1">{metrics.marketing.voucherRedemptions}</p>
          <p className="text-xs text-[var(--fg-muted)]">{formatCurrency(metrics.marketing.voucherCreditsGiven)} given</p>
        </div>

        {/* Referrals */}
        <div className="bg-white rounded-xl border border-[var(--line)] p-4">
          <span className="text-sm text-[var(--fg-muted)]">Referral Claims</span>
          <p className="text-xl font-bold text-[var(--fg)] mt-1">{metrics.marketing.referralClaims}</p>
          <p className="text-xs text-[var(--fg-muted)]">{metrics.marketing.referralConversions} converted</p>
        </div>
      </div>

      {/* Customer Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Customer Types */}
        <div className="bg-white rounded-xl border border-[var(--line)] p-6">
          <h3 className="font-semibold text-[var(--fg)] mb-4">Customer Types</h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-[var(--fg-muted)]">Hourly (Pay-as-you-go)</span>
              <span className="font-medium text-[var(--fg)]">{metrics.customers.hourly}</span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2">
              <div
                className="bg-[var(--acid)] h-2 rounded-full"
                style={{ width: `${(metrics.customers.hourly / metrics.customers.total) * 100}%` }}
              />
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-[var(--fg-muted)]">Monthly Subscription</span>
              <span className="font-medium text-[var(--fg)]">{metrics.customers.monthly}</span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2">
              <div
                className="bg-emerald-500 h-2 rounded-full"
                style={{ width: `${(metrics.customers.monthly / metrics.customers.total) * 100}%` }}
              />
            </div>
            <div className="flex justify-between items-center pt-2 border-t border-[var(--line)]">
              <span className="text-sm text-[var(--fg-muted)]">Active with balance</span>
              <span className="font-medium text-emerald-600">{metrics.customers.active}</span>
            </div>
          </div>
        </div>

        {/* Top Spenders */}
        <div className="bg-white rounded-xl border border-[var(--line)] p-6">
          <h3 className="font-semibold text-[var(--fg)] mb-4">Top Spenders</h3>
          <div className="space-y-2">
            {metrics.topCustomers.bySpending.slice(0, 5).map((c, i) => (
              <div key={c.id} className="flex justify-between items-center text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-[var(--fg-muted)]">{i + 1}.</span>
                  <span className="text-[var(--fg)] truncate max-w-[150px]" title={c.email}>
                    {c.name}
                  </span>
                </div>
                <span className="font-medium text-[var(--fg)]">{formatCurrency(c.spent || 0)}</span>
              </div>
            ))}
            {metrics.topCustomers.bySpending.length === 0 && (
              <p className="text-sm text-[var(--fg-muted)]">No spending data</p>
            )}
          </div>
        </div>

        {/* Top Balances */}
        <div className="bg-white rounded-xl border border-[var(--line)] p-6">
          <h3 className="font-semibold text-[var(--fg)] mb-4">Highest Balances</h3>
          <div className="space-y-2">
            {metrics.topCustomers.byBalance.slice(0, 5).map((c, i) => (
              <div key={c.id} className="flex justify-between items-center text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-[var(--fg-muted)]">{i + 1}.</span>
                  <span className="text-[var(--fg)] truncate max-w-[150px]" title={c.email}>
                    {c.name}
                  </span>
                </div>
                <span className="font-medium text-emerald-600">{formatCurrency(c.balance || 0)}</span>
              </div>
            ))}
            {metrics.topCustomers.byBalance.length === 0 && (
              <p className="text-sm text-[var(--fg-muted)]">No balance data</p>
            )}
          </div>
        </div>
      </div>

      {/* Provider Economics */}
      <div className="bg-white rounded-xl border border-[var(--line)] p-6">
        <h3 className="font-semibold text-[var(--fg)] mb-4">Provider Economics</h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <p className="text-sm text-[var(--fg-muted)]">Customer Revenue</p>
            <p className="text-xl font-bold text-[var(--fg)]">{formatCurrency(metrics.providers.revenue)}</p>
          </div>
          <div>
            <p className="text-sm text-[var(--fg-muted)]">Provider Earnings</p>
            <p className="text-xl font-bold text-orange-600">{formatCurrency(metrics.providers.earnings)}</p>
          </div>
          <div>
            <p className="text-sm text-[var(--fg-muted)]">Packet Margin</p>
            <p className="text-xl font-bold text-emerald-600">{formatCurrency(metrics.providers.margin)}</p>
          </div>
          <div>
            <p className="text-sm text-[var(--fg-muted)]">Margin %</p>
            <p className="text-xl font-bold text-[var(--fg)]">
              {metrics.providers.revenue > 0
                ? ((metrics.providers.margin / metrics.providers.revenue) * 100).toFixed(1)
                : 0}
              %
            </p>
          </div>
        </div>
      </div>

      {/* Drill-down Modal */}
      {drillDown && (
        <DrillDownModal
          type={drillDown}
          metrics={metrics}
          onClose={() => setDrillDown(null)}
          formatCurrency={formatCurrency}
          formatNumber={formatNumber}
        />
      )}
    </div>
  );
}

// Drill-down modal component
function DrillDownModal({
  type,
  metrics,
  onClose,
  formatCurrency,
  formatNumber,
}: {
  type: DrillDownType;
  metrics: BusinessMetrics;
  onClose: () => void;
  formatCurrency: (v: number) => string;
  formatNumber: (v: number) => string;
}) {
  if (!type) return null;

  const titles: Record<NonNullable<DrillDownType>, string> = {
    revenue: "Revenue Details",
    customers: "Customer Details",
    gpu: "GPU Usage Details",
    providers: "Provider Details",
    marketing: "Marketing & Promotions",
    topCustomers: "Top Customers",
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl max-w-4xl w-full max-h-[80vh] overflow-y-auto">
        <div className="sticky top-0 bg-white border-b border-[var(--line)] px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--fg)]">{titles[type]}</h2>
          <button onClick={onClose} className="text-[var(--fg-muted)] hover:text-[var(--fg)]">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-6">
          {type === "revenue" && (
            <div className="space-y-6">
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-[var(--ink)] rounded-lg p-4">
                  <p className="text-sm text-[var(--fg-muted)]">Total Revenue</p>
                  <p className="text-2xl font-bold text-[var(--fg)]">{formatCurrency(metrics.revenue.total)}</p>
                </div>
                <div className="bg-[var(--ink)] rounded-lg p-4">
                  <p className="text-sm text-[var(--fg-muted)]">Previous Period</p>
                  <p className="text-2xl font-bold text-[var(--fg)]">{formatCurrency(metrics.revenue.previous)}</p>
                </div>
                <div className="bg-[var(--ink)] rounded-lg p-4">
                  <p className="text-sm text-[var(--fg-muted)]">Refunds</p>
                  <p className="text-2xl font-bold text-red-600">{formatCurrency(metrics.revenue.refunds)}</p>
                </div>
              </div>

              <div>
                <h3 className="font-medium text-[var(--fg)] mb-3">Daily Breakdown</h3>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-[var(--ink)]">
                      <tr>
                        <th className="text-left px-4 py-2 text-xs font-medium text-[var(--fg-muted)]">Date</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-[var(--fg-muted)]">Revenue</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-[var(--fg-muted)]">Deposits</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--line)]">
                      {metrics.revenue.daily.map((d) => (
                        <tr key={d.date}>
                          <td className="px-4 py-2 text-sm text-[var(--fg)]">{d.date}</td>
                          <td className="px-4 py-2 text-sm text-right font-medium text-[var(--fg)]">
                            {formatCurrency(d.revenue)}
                          </td>
                          <td className="px-4 py-2 text-sm text-right text-[var(--fg-muted)]">{d.deposits}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {type === "customers" && (
            <div className="space-y-6">
              <div className="grid grid-cols-4 gap-4">
                <div className="bg-[var(--ink)] rounded-lg p-4">
                  <p className="text-sm text-[var(--fg-muted)]">Total Customers</p>
                  <p className="text-2xl font-bold text-[var(--fg)]">{metrics.customers.total}</p>
                </div>
                <div className="bg-[var(--ink)] rounded-lg p-4">
                  <p className="text-sm text-[var(--fg-muted)]">New This Period</p>
                  <p className="text-2xl font-bold text-emerald-600">{metrics.customers.new}</p>
                </div>
                <div className="bg-[var(--ink)] rounded-lg p-4">
                  <p className="text-sm text-[var(--fg-muted)]">Active (w/ balance)</p>
                  <p className="text-2xl font-bold text-[var(--fg)]">{metrics.customers.active}</p>
                </div>
                <div className="bg-[var(--ink)] rounded-lg p-4">
                  <p className="text-sm text-[var(--fg-muted)]">Avg Value</p>
                  <p className="text-2xl font-bold text-[var(--fg)]">{formatCurrency(metrics.customers.avgValue)}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="bg-blue-50 rounded-lg p-4">
                  <p className="text-sm text-blue-600">Hourly Customers</p>
                  <p className="text-2xl font-bold text-blue-700">{metrics.customers.hourly}</p>
                  <p className="text-xs text-blue-600">
                    {((metrics.customers.hourly / metrics.customers.total) * 100).toFixed(1)}% of total
                  </p>
                </div>
                <div className="bg-emerald-50 rounded-lg p-4">
                  <p className="text-sm text-emerald-600">Monthly Customers</p>
                  <p className="text-2xl font-bold text-emerald-700">{metrics.customers.monthly}</p>
                  <p className="text-xs text-emerald-600">
                    {((metrics.customers.monthly / metrics.customers.total) * 100).toFixed(1)}% of total
                  </p>
                </div>
              </div>

              <div>
                <h3 className="font-medium text-[var(--fg)] mb-3">Daily Signups</h3>
                <div className="overflow-x-auto max-h-64">
                  <table className="w-full">
                    <thead className="bg-[var(--ink)] sticky top-0">
                      <tr>
                        <th className="text-left px-4 py-2 text-xs font-medium text-[var(--fg-muted)]">Date</th>
                        <th className="text-right px-4 py-2 text-xs font-medium text-[var(--fg-muted)]">Signups</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--line)]">
                      {metrics.customers.dailySignups.map((d) => (
                        <tr key={d.date}>
                          <td className="px-4 py-2 text-sm text-[var(--fg)]">{d.date}</td>
                          <td className="px-4 py-2 text-sm text-right font-medium text-[var(--fg)]">{d.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {type === "gpu" && (
            <div className="space-y-6">
              <div className="grid grid-cols-4 gap-4">
                <div className="bg-[var(--ink)] rounded-lg p-4">
                  <p className="text-sm text-[var(--fg-muted)]">Active GPUs</p>
                  <p className="text-2xl font-bold text-[var(--fg)]">{metrics.gpu.activeGPUs}</p>
                </div>
                <div className="bg-[var(--ink)] rounded-lg p-4">
                  <p className="text-sm text-[var(--fg-muted)]">Active Pods</p>
                  <p className="text-2xl font-bold text-[var(--fg)]">{metrics.gpu.activePods}</p>
                </div>
                <div className="bg-[var(--ink)] rounded-lg p-4">
                  <p className="text-sm text-[var(--fg-muted)]">Hours Used</p>
                  <p className="text-2xl font-bold text-[var(--fg)]">{formatNumber(metrics.gpu.totalHoursUsed)}</p>
                </div>
                <div className="bg-[var(--ink)] rounded-lg p-4">
                  <p className="text-sm text-[var(--fg-muted)]">Avg Utilization</p>
                  <p className="text-2xl font-bold text-emerald-600">{metrics.gpu.avgUtilization.toFixed(1)}%</p>
                </div>
              </div>

              <div className="bg-blue-50 rounded-lg p-6">
                <h3 className="font-medium text-blue-900 mb-2">Usage Cost</h3>
                <p className="text-3xl font-bold text-blue-700">{formatCurrency(metrics.gpu.totalUsageCost)}</p>
                <p className="text-sm text-blue-600 mt-1">
                  {metrics.gpu.totalHoursUsed > 0
                    ? `${formatCurrency(metrics.gpu.totalUsageCost / metrics.gpu.totalHoursUsed)}/hour avg`
                    : "No usage data"}
                </p>
              </div>
            </div>
          )}

          {type === "providers" && (
            <div className="space-y-6">
              <div className="grid grid-cols-4 gap-4">
                <div className="bg-[var(--ink)] rounded-lg p-4">
                  <p className="text-sm text-[var(--fg-muted)]">Total Providers</p>
                  <p className="text-2xl font-bold text-[var(--fg)]">{metrics.providers.total}</p>
                </div>
                <div className="bg-[var(--ink)] rounded-lg p-4">
                  <p className="text-sm text-[var(--fg-muted)]">Active Providers</p>
                  <p className="text-2xl font-bold text-emerald-600">{metrics.providers.active}</p>
                </div>
                <div className="bg-[var(--ink)] rounded-lg p-4">
                  <p className="text-sm text-[var(--fg-muted)]">Total Nodes</p>
                  <p className="text-2xl font-bold text-[var(--fg)]">{metrics.providers.totalNodes}</p>
                </div>
                <div className="bg-[var(--ink)] rounded-lg p-4">
                  <p className="text-sm text-[var(--fg-muted)]">Active Nodes</p>
                  <p className="text-2xl font-bold text-emerald-600">{metrics.providers.activeNodes}</p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="bg-blue-50 rounded-lg p-4">
                  <p className="text-sm text-blue-600">Customer Revenue</p>
                  <p className="text-2xl font-bold text-blue-700">{formatCurrency(metrics.providers.revenue)}</p>
                </div>
                <div className="bg-orange-50 rounded-lg p-4">
                  <p className="text-sm text-orange-600">Provider Payouts</p>
                  <p className="text-2xl font-bold text-orange-700">{formatCurrency(metrics.providers.payouts)}</p>
                </div>
                <div className="bg-emerald-50 rounded-lg p-4">
                  <p className="text-sm text-emerald-600">Packet Margin</p>
                  <p className="text-2xl font-bold text-emerald-700">{formatCurrency(metrics.providers.margin)}</p>
                </div>
              </div>
            </div>
          )}

          {type === "marketing" && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <h3 className="font-medium text-[var(--fg)] mb-4">Vouchers</h3>
                  <div className="space-y-3">
                    <div className="bg-[var(--ink)] rounded-lg p-4">
                      <p className="text-sm text-[var(--fg-muted)]">Active Vouchers</p>
                      <p className="text-2xl font-bold text-[var(--fg)]">{metrics.marketing.activeVouchers}</p>
                    </div>
                    <div className="bg-[var(--ink)] rounded-lg p-4">
                      <p className="text-sm text-[var(--fg-muted)]">Redemptions</p>
                      <p className="text-2xl font-bold text-emerald-600">{metrics.marketing.voucherRedemptions}</p>
                    </div>
                    <div className="bg-[var(--ink)] rounded-lg p-4">
                      <p className="text-sm text-[var(--fg-muted)]">Credits Given</p>
                      <p className="text-2xl font-bold text-[var(--fg)]">
                        {formatCurrency(metrics.marketing.voucherCreditsGiven)}
                      </p>
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="font-medium text-[var(--fg)] mb-4">Referrals</h3>
                  <div className="space-y-3">
                    <div className="bg-[var(--ink)] rounded-lg p-4">
                      <p className="text-sm text-[var(--fg-muted)]">Active Referral Codes</p>
                      <p className="text-2xl font-bold text-[var(--fg)]">{metrics.marketing.activeReferralCodes}</p>
                    </div>
                    <div className="bg-[var(--ink)] rounded-lg p-4">
                      <p className="text-sm text-[var(--fg-muted)]">Claims</p>
                      <p className="text-2xl font-bold text-blue-600">{metrics.marketing.referralClaims}</p>
                    </div>
                    <div className="bg-[var(--ink)] rounded-lg p-4">
                      <p className="text-sm text-[var(--fg-muted)]">Conversions</p>
                      <p className="text-2xl font-bold text-emerald-600">{metrics.marketing.referralConversions}</p>
                      <p className="text-xs text-[var(--fg-muted)]">
                        {metrics.marketing.referralClaims > 0
                          ? `${((metrics.marketing.referralConversions / metrics.marketing.referralClaims) * 100).toFixed(1)}% rate`
                          : "No claims yet"}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {type === "topCustomers" && (
            <div className="space-y-6">
              <div>
                <h3 className="font-medium text-[var(--fg)] mb-4">Top 10 by Spending</h3>
                <table className="w-full">
                  <thead className="bg-[var(--ink)]">
                    <tr>
                      <th className="text-left px-4 py-2 text-xs font-medium text-[var(--fg-muted)]">#</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-[var(--fg-muted)]">Customer</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-[var(--fg-muted)]">Email</th>
                      <th className="text-right px-4 py-2 text-xs font-medium text-[var(--fg-muted)]">Spent</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line)]">
                    {metrics.topCustomers.bySpending.map((c, i) => (
                      <tr key={c.id}>
                        <td className="px-4 py-2 text-sm text-[var(--fg-muted)]">{i + 1}</td>
                        <td className="px-4 py-2 text-sm text-[var(--fg)]">{c.name}</td>
                        <td className="px-4 py-2 text-sm text-[var(--fg-muted)]">{c.email}</td>
                        <td className="px-4 py-2 text-sm text-right font-medium text-[var(--fg)]">
                          {formatCurrency(c.spent || 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div>
                <h3 className="font-medium text-[var(--fg)] mb-4">Top 10 by Wallet Balance</h3>
                <table className="w-full">
                  <thead className="bg-[var(--ink)]">
                    <tr>
                      <th className="text-left px-4 py-2 text-xs font-medium text-[var(--fg-muted)]">#</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-[var(--fg-muted)]">Customer</th>
                      <th className="text-left px-4 py-2 text-xs font-medium text-[var(--fg-muted)]">Email</th>
                      <th className="text-right px-4 py-2 text-xs font-medium text-[var(--fg-muted)]">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line)]">
                    {metrics.topCustomers.byBalance.map((c, i) => (
                      <tr key={c.id}>
                        <td className="px-4 py-2 text-sm text-[var(--fg-muted)]">{i + 1}</td>
                        <td className="px-4 py-2 text-sm text-[var(--fg)]">{c.name}</td>
                        <td className="px-4 py-2 text-sm text-[var(--fg-muted)]">{c.email}</td>
                        <td className="px-4 py-2 text-sm text-right font-medium text-emerald-600">
                          {formatCurrency(c.balance || 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
