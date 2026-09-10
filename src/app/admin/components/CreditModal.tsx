"use client";

import { useState } from "react";
import type { Customer } from "../types";

const ADJUSTMENT_REASONS = [
  { value: "bug_fix", label: "Bug / System failure" },
  { value: "goodwill", label: "Goodwill / Customer retention" },
  { value: "marketing", label: "Marketing / Promotion" },
  { value: "overcharge", label: "Overcharge correction" },
  { value: "onboarding", label: "New customer onboarding" },
  { value: "other", label: "Other (specify below)" },
] as const;

export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number]["value"];

interface CreditModalProps {
  customer: Customer;
  creditAmount: string;
  actionLoading: string | null;
  onCreditAmountChange: (amount: string) => void;
  onSubmit: (e: React.FormEvent, reason: string, reasonNote: string) => void;
  onClose: () => void;
}

export function CreditModal({
  customer,
  creditAmount,
  actionLoading,
  onCreditAmountChange,
  onSubmit,
  onClose,
}: CreditModalProps) {
  const [reason, setReason] = useState<string>("");
  const [reasonNote, setReasonNote] = useState("");

  const isReasonValid = reason && (reason !== "other" || reasonNote.trim().length > 0);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white border border-[var(--line)] rounded-lg p-6 w-full max-w-md mx-4">
        <h3 className="text-lg font-semibold mb-4 text-[var(--fg)]">Adjust Credits</h3>
        <div className="mb-4">
          <p className="text-sm text-[var(--fg-muted)]">Customer: {customer.email}</p>
          <p className="text-sm text-[var(--fg-muted)]">
            Current balance: <span className="text-emerald-600 font-medium">${(customer.walletBalance / 100).toFixed(2)}</span>
          </p>
        </div>
        <form onSubmit={(e) => onSubmit(e, reason, reasonNote)}>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2 text-[var(--fg)]">
              Amount (positive to add, negative to remove)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--fg-muted)]">$</span>
              <input
                type="number"
                step="0.01"
                value={creditAmount}
                onChange={(e) => onCreditAmountChange(e.target.value)}
                placeholder="10.00"
                className="w-full pl-7 pr-4 py-2 bg-white border border-[var(--line)] rounded-lg text-[var(--fg)] placeholder-[#5b6476] focus:outline-none focus:ring-2 focus:ring-[var(--acid)]"
                autoFocus
              />
            </div>
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2 text-[var(--fg)]">
              Reason <span className="text-red-500">*</span>
            </label>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-2 bg-white border border-[var(--line)] rounded-lg text-[var(--fg)] focus:outline-none focus:ring-2 focus:ring-[var(--acid)]"
            >
              <option value="">Select a reason...</option>
              {ADJUSTMENT_REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          {reason === "other" && (
            <div className="mb-4">
              <label className="block text-sm font-medium mb-2 text-[var(--fg)]">
                Details <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={reasonNote}
                onChange={(e) => setReasonNote(e.target.value)}
                placeholder="Explain the reason for this adjustment..."
                className="w-full px-3 py-2 bg-white border border-[var(--line)] rounded-lg text-[var(--fg)] placeholder-[#5b6476] focus:outline-none focus:ring-2 focus:ring-[var(--acid)]"
              />
            </div>
          )}
          {reason && reason !== "other" && (
            <div className="mb-4">
              <label className="block text-sm font-medium mb-2 text-[var(--fg)]">
                Additional notes <span className="text-[var(--fg-muted)] font-normal">(optional)</span>
              </label>
              <input
                type="text"
                value={reasonNote}
                onChange={(e) => setReasonNote(e.target.value)}
                placeholder="Any extra context..."
                className="w-full px-3 py-2 bg-white border border-[var(--line)] rounded-lg text-[var(--fg)] placeholder-[#5b6476] focus:outline-none focus:ring-2 focus:ring-[var(--acid)]"
              />
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-white border border-[var(--line)] hover:bg-gray-50 text-[var(--fg)] rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!creditAmount || !isReasonValid || actionLoading === customer.id}
              className="px-4 py-2 bg-[var(--acid)] hover:bg-[var(--acid-deep)] text-white rounded-lg font-medium disabled:opacity-50"
            >
              {actionLoading === customer.id ? "Adjusting..." : "Adjust Credits"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
