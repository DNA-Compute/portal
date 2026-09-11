"use client";

import { useState } from "react";
import {
  GettingStartedDoc,
  HuggingFaceDoc,
  Pro6000BlackwellDoc,
  OpenAIGatewayDoc,
  InferencePlaygroundDoc,
  GPUMetricsDoc,
  TokenUsageDoc,
  ServiceExposureDoc,
  PersistentStorageDoc,
  SSHAccessDoc,
  BillingDoc,
  BudgetControlsDoc,
  WorkspaceDoc,
  BrowserIDEDoc,
} from "./docs";


type DocSection =
  | "getting-started"
  | "huggingface"
  | "pro-6000-blackwell"
  | "openai-gateway"
  | "inference-playground"
  | "gpu-metrics"
  | "token-usage"
  | "service-exposure"
  | "persistent-storage"
  | "ssh-access"
  | "workspace"
  | "browser-ide"
  | "billing"
  | "budget-controls";

interface NavItemConfig {
  id: DocSection;
  label: string;
  shortLabel: string;
  isNew?: boolean;
}

const navItems: NavItemConfig[] = [
  // Getting Started & Deployment
  { id: "getting-started", label: "Getting Started", shortLabel: "Start" },
  { id: "huggingface", label: "HuggingFace Deploy", shortLabel: "HF" },
  { id: "pro-6000-blackwell", label: "Pro 6000 Blackwell", shortLabel: "Pro 6000", isNew: true },
  // Using Your Models
  { id: "openai-gateway", label: "OpenAI API", shortLabel: "API", isNew: true },
  { id: "inference-playground", label: "Playground", shortLabel: "Play", isNew: true },
  // Monitoring & Analytics
  { id: "gpu-metrics", label: "GPU Metrics", shortLabel: "GPU", isNew: true },
  { id: "token-usage", label: "Token Usage", shortLabel: "Tokens", isNew: true },
  // Advanced Configuration
  { id: "service-exposure", label: "Service Exposure", shortLabel: "Services" },
  { id: "persistent-storage", label: "Storage", shortLabel: "Storage" },
  { id: "ssh-access", label: "SSH Access", shortLabel: "SSH" },
  { id: "workspace", label: "Persistent Workspace", shortLabel: "Workspace", isNew: true },
  { id: "browser-ide", label: "Browser IDEs", shortLabel: "IDEs", isNew: true },
  // Account & Reference
  { id: "billing", label: "Billing", shortLabel: "Billing" },
  { id: "budget-controls", label: "Budget Controls", shortLabel: "Budget", isNew: true },
];

export function DocsTab() {
  const [activeSection, setActiveSection] = useState<DocSection>("getting-started");

  const renderDocContent = () => {
    switch (activeSection) {
      // Getting Started & Deployment
      case "getting-started":
        return <GettingStartedDoc />;
      case "huggingface":
        return <HuggingFaceDoc />;
      case "pro-6000-blackwell":
        return <Pro6000BlackwellDoc />;
      // Using Your Models
      case "openai-gateway":
        return <OpenAIGatewayDoc />;
      case "inference-playground":
        return <InferencePlaygroundDoc />;
      // Monitoring & Analytics
      case "gpu-metrics":
        return <GPUMetricsDoc />;
      case "token-usage":
        return <TokenUsageDoc />;
      // Advanced Configuration
      case "service-exposure":
        return <ServiceExposureDoc />;
      case "persistent-storage":
        return <PersistentStorageDoc />;
      case "ssh-access":
        return <SSHAccessDoc />;
      case "workspace":
        return <WorkspaceDoc />;
      case "browser-ide":
        return <BrowserIDEDoc />;
      // Account & Reference
      case "billing":
        return <BillingDoc />;
      case "budget-controls":
        return <BudgetControlsDoc />;
      default:
        return <GettingStartedDoc />;
    }
  };

  const currentItem = navItems.find(item => item.id === activeSection);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-900">Documentation</h1>
        <span className="text-sm text-teal-600 font-medium">
          Need help? Use the Support tab
        </span>
      </div>

      {/* Navigation Select */}
      <div className="flex items-center gap-3">
        <label htmlFor="doc-section" className="text-sm font-medium text-zinc-500">
          Topic:
        </label>
        <select
          id="doc-section"
          value={activeSection}
          onChange={(e) => setActiveSection(e.target.value as DocSection)}
          className="flex-1 max-w-md px-4 py-2.5 text-sm font-medium text-zinc-900 bg-white border border-zinc-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 cursor-pointer"
        >
          <optgroup label="Getting Started">
            <option value="getting-started">Getting Started</option>
            <option value="huggingface">HuggingFace Deploy</option>
            <option value="pro-6000-blackwell">Pro 6000 Blackwell ✨</option>
          </optgroup>
          <optgroup label="Using Your Models">
            <option value="openai-gateway">OpenAI API ✨</option>
            <option value="inference-playground">Playground ✨</option>
          </optgroup>
          <optgroup label="Monitoring">
            <option value="gpu-metrics">GPU Metrics ✨</option>
            <option value="token-usage">Token Usage ✨</option>
          </optgroup>
          <optgroup label="Configuration">
            <option value="service-exposure">Service Exposure</option>
            <option value="persistent-storage">Storage</option>
            <option value="ssh-access">SSH Access</option>
            <option value="workspace">Persistent Workspace ✨</option>
            <option value="browser-ide">Browser IDEs ✨</option>
          </optgroup>
          <optgroup label="Account">
            <option value="billing">Billing</option>
            <option value="budget-controls">Budget Controls ✨</option>
          </optgroup>
        </select>
        {currentItem?.isNew && (
          <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-emerald-100 text-emerald-700">
            NEW
          </span>
        )}
      </div>

      {/* Content */}
      <div className="bg-white rounded-2xl border border-zinc-200 p-8">
        <div className="[&_pre]:overflow-x-auto [&_pre]:max-w-full [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full">
          {renderDocContent()}
        </div>
      </div>
    </div>
  );
}
