"use client";

import { useMemo } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import type { BillingStats } from "./types";

interface UsageChartProps {
  charges: BillingStats["dailyCharges"] | null;
  error?: string | null;
}

export function UsageChart({ charges, error }: UsageChartProps) {
  const chartData = useMemo(() => (charges ?? []).map(charge => ({
    fullDate: new Date(`${charge.date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }),
    spend: charge.amountCents / 100,
  })), [charges]);

  if (!charges || error) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-400 text-sm">
        {error ? "Wallet charges unavailable" : "Loading wallet charges…"}
      </div>
    );
  }

  const maxSpend = Math.max(...chartData.map((d) => d.spend), 0.5);
  // Width needed to fit the largest Y-axis label (e.g. "$10000") without clipping.
  // ~8px per character at 11px font size, plus 16px for the "$" prefix and right padding.
  const yAxisWidth = Math.max(40, String(Math.ceil(maxSpend * 1.2)).length * 8 + 16);
  const hasData = chartData.some(d => d.spend > 0);

  if (!hasData) {
    return (
      <div className="h-full flex items-center justify-center text-zinc-400 text-sm">
        No wallet charges in this period
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="spendGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.2} />
            <stop offset="100%" stopColor="#f43f5e" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="fullDate"
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 11, fill: "#71717a" }}
          tickMargin={8}
          interval={Math.ceil(chartData.length / 5)}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tick={{ fontSize: 11, fill: "#71717a" }}
          tickFormatter={(v) => `$${v}`}
          width={yAxisWidth}
          domain={[0, Math.ceil(maxSpend * 1.2)]}
          tickCount={4}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "#18181b",
            border: "none",
            borderRadius: "8px",
            fontSize: "12px",
            color: "#fff",
            padding: "8px 12px",
          }}
          formatter={(value) => {
            const numValue = typeof value === "number" ? value : 0;
            return [`$${numValue.toFixed(2)}`, "Wallet charges"];
          }}
          labelFormatter={(label) => label}
          labelStyle={{ color: "#a1a1aa", marginBottom: "4px" }}
        />
        <Area
          type="monotone"
          dataKey="spend"
          stroke="#f43f5e"
          strokeWidth={2}
          fill="url(#spendGradient)"
          dot={false}
          activeDot={{ r: 4, fill: "#f43f5e", stroke: "#fff", strokeWidth: 2 }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
