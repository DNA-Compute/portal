/**
 * Dashboard components - modular exports
 *
 * Usage:
 *   import { StatusDot, UsageChart, TerminalModal } from "@/app/dashboard/components";
 *
 * Or import from specific modules:
 *   import { StatusDot } from "@/app/dashboard/components/StatusDot";
 */

// Re-export all types
export * from "./types";

// Re-export utility functions
export * from "./utils";

// Re-export UI components
export { StatusDot } from "./StatusDot";
export { UsageChart } from "./UsageChart";
export { GPUUsageChart } from "./GPUUsageChart";
export { GeometricHeader } from "./GeometricHeader";
export { NavItem } from "./NavItem";

// Re-export modal components
export { TerminalModal } from "./TerminalModal";
export { RunScriptModal } from "./RunScriptModal";
export { LaunchConfigurator } from "./LaunchConfigurator";

// Re-export card components
export { PoolSubscriptionCard, type PoolSubscriptionCardProps } from "./PoolSubscriptionCard";
export { SnapshotCard } from "./SnapshotCard";

// Re-export tab components
export { MetricsTab } from "./MetricsTab";
export { BillingTab } from "./BillingTab";
// OSS stub — original: export { BareMetalTab } from "./BareMetalTab";
export const BareMetalTab = (_props?: unknown) => null;

// Re-export main dashboard content
export { DashboardContent } from "./DashboardContent";
