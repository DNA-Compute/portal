/**
 * Topup Modal Component
 *
 * Modal for adding funds to wallet with optional voucher code.
 * Vouchers without a minimum top-up requirement can be redeemed directly.
 *
 * @module dashboard/modals/TopupModal
 */

"use client";

import React from "react";
import { CUSTOM_TOP_UP, isValidTopUpAmount } from "@/lib/wallet-topup";

/** Rough GPU time a top-up buys, at the ~$2/hour the tiles have always quoted. */
const gpuHours = (cents: number) => Math.floor(cents / 200);
const presets = [10000, 25000, 100000];

interface ValidatedVoucher {
  code: string;
  name: string;
  creditCents: number;
  minTopupCents: number | null;
}

interface TopupModalProps {
  isOpen: boolean;
  onClose: () => void;
  token: string;
  topupLoading: boolean;
  onTopup: (amount: number, voucherCode?: string) => void;
  onVoucherRedeemed?: () => void;
}

export function TopupModal({
  isOpen,
  onClose,
  token,
  topupLoading,
  onTopup,
  onVoucherRedeemed,
}: TopupModalProps) {
  const [voucherCode, setVoucherCode] = React.useState("");
  const [voucherValidating, setVoucherValidating] = React.useState(false);
  const [validatedVoucher, setValidatedVoucher] = React.useState<ValidatedVoucher | null>(null);
  const [voucherError, setVoucherError] = React.useState<string | null>(null);
  const [redeeming, setRedeeming] = React.useState(false);
  const [redeemSuccess, setRedeemSuccess] = React.useState<number | null>(null); // credited cents
  const [customDollars, setCustomDollars] = React.useState("");

  // Reset state when modal closes
  React.useEffect(() => {
    if (!isOpen) {
      setVoucherCode("");
      setValidatedVoucher(null);
      setVoucherError(null);
      setRedeeming(false);
      setRedeemSuccess(null);
      setCustomDollars("");
    }
  }, [isOpen]);

  const validateVoucherCode = React.useCallback(async (code: string) => {
    if (!code.trim() || !token) {
      setValidatedVoucher(null);
      setVoucherError(null);
      return;
    }

    setVoucherValidating(true);
    setVoucherError(null);

    try {
      const res = await fetch("/api/account/voucher/validate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ code }),
      });
      const result = await res.json();

      if (result.success && result.voucher) {
        setValidatedVoucher(result.voucher);
        setVoucherError(null);
      } else {
        setValidatedVoucher(null);
        setVoucherError(result.error || "Invalid voucher code");
      }
    } catch {
      setValidatedVoucher(null);
      setVoucherError("Failed to validate voucher");
    } finally {
      setVoucherValidating(false);
    }
  }, [token]);

  const handleRedeemVoucher = React.useCallback(async () => {
    if (!validatedVoucher || !token || redeeming) return;

    setRedeeming(true);
    setVoucherError(null);

    try {
      const res = await fetch("/api/account/voucher/redeem", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ code: validatedVoucher.code }),
      });
      const result = await res.json();

      if (result.success) {
        setRedeemSuccess(result.creditCents);
        onVoucherRedeemed?.();
      } else {
        setVoucherError(result.error || "Failed to redeem voucher");
      }
    } catch {
      setVoucherError("Failed to redeem voucher");
    } finally {
      setRedeeming(false);
    }
  }, [validatedVoucher, token, redeeming, onVoucherRedeemed]);

  const handleTopupWithVoucher = React.useCallback((amount: number) => {
    onTopup(amount, validatedVoucher?.code);
  }, [onTopup, validatedVoucher]);

  const customCents = Math.round(Number(customDollars) * 100);
  const customMinCents = Math.max(CUSTOM_TOP_UP.minCents, validatedVoucher?.minTopupCents ?? 0);
  const customValid = customDollars.trim() !== "" && isValidTopUpAmount(customCents) && customCents >= customMinCents;

  // Whether this voucher can be redeemed without a payment
  const isFreeVoucher = validatedVoucher && !validatedVoucher.minTopupCents;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md mx-4 shadow-xl">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-lg font-semibold text-zinc-900">Top Up Wallet</h3>
          <button
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-600 p-1"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Success state after voucher-only redemption */}
        {redeemSuccess !== null ? (
          <div className="text-center py-6">
            <div className="w-12 h-12 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="text-lg font-semibold text-zinc-900 mb-1">
              ${(redeemSuccess / 100).toFixed(0)} added to your wallet
            </p>
            <p className="text-sm text-zinc-500 mb-6">Your voucher has been redeemed successfully.</p>
            <button
              onClick={onClose}
              className="px-6 py-2 bg-[var(--acid)] text-[var(--ink)] font-semibold text-sm rounded-lg hover:bg-[var(--acid-deep)] transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <>
            {!isFreeVoucher && (
              <p className="text-sm text-zinc-600 mb-6">
                Add funds to your wallet for GPU usage. Your card will be charged immediately.
              </p>
            )}

            {/* Voucher Code Input */}
            <div className={isFreeVoucher ? "mb-2" : "mb-4 pt-2 border-t border-[var(--line)]"}>
              <label className="text-xs text-[var(--muted)] mb-1 block">Voucher code</label>
              <div className="flex gap-2">
                <input
                  id="voucher-input"
                  type="text"
                  value={voucherCode}
                  onChange={(e) => setVoucherCode(e.target.value.toUpperCase())}
                  placeholder="Enter voucher code"
                  className="flex-1 px-2 py-1.5 border border-[var(--line)] rounded text-xs focus:outline-none focus:ring-1 focus:ring-[var(--acid)] uppercase"
                />
                <button
                  onClick={() => validateVoucherCode(voucherCode)}
                  disabled={!voucherCode.trim() || voucherValidating}
                  className="px-3 py-1.5 bg-[var(--acid)] text-[var(--ink)] font-semibold text-xs rounded hover:bg-[var(--acid-deep)] disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  {voucherValidating ? "..." : "Apply"}
                </button>
              </div>
              {voucherError && (
                <p className="mt-1 text-xs text-red-600">{voucherError}</p>
              )}
              {validatedVoucher && (
                <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded text-xs">
                  <div className="flex items-center gap-1">
                    <svg className="w-3.5 h-3.5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="text-green-700 font-medium">{validatedVoucher.name}</span>
                    <span className="text-green-600">+${(validatedVoucher.creditCents / 100).toFixed(0)} credit</span>
                  </div>
                  {isFreeVoucher ? (
                    <p className="text-green-600 mt-1">Click redeem to add this credit to your wallet.</p>
                  ) : validatedVoucher.minTopupCents ? (
                    <p className="text-amber-600 mt-1">
                      Requires a minimum ${(validatedVoucher.minTopupCents / 100).toFixed(0)} deposit. Select an amount below.
                    </p>
                  ) : (
                    <p className="text-green-600 mt-1">Select an amount below to apply this bonus.</p>
                  )}
                </div>
              )}
            </div>

            {/* Free voucher: show Redeem button */}
            {isFreeVoucher ? (
              <div className="pt-2">
                <button
                  onClick={handleRedeemVoucher}
                  disabled={redeeming}
                  className="w-full py-3 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-xl transition-colors disabled:opacity-50"
                >
                  {redeeming ? "Redeeming..." : `Redeem $${(validatedVoucher.creditCents / 100).toFixed(0)} Credit`}
                </button>
              </div>
            ) : (
              <>
                <form
                  onSubmit={(event) => { event.preventDefault(); if (customValid) handleTopupWithVoucher(customCents); }}
                  className="mb-6 space-y-3"
                >
                  <div className="grid grid-cols-2 auto-rows-fr gap-3">
                    {presets.map((value) => {
                      const belowMinimum = !!validatedVoucher?.minTopupCents && value < validatedVoucher.minTopupCents;
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => handleTopupWithVoucher(value)}
                          disabled={topupLoading || belowMinimum}
                          className="flex flex-col items-center justify-center gap-1 p-4 border border-[var(--line)] bg-[var(--ink-sink)] hover:border-[var(--acid)] hover:bg-[var(--ink-raise)] transition-colors disabled:opacity-50"
                        >
                          <span className="text-xl font-bold text-zinc-900">${(value / 100).toLocaleString("en-US")}</span>
                          <GpuTime cents={value} bonusCents={validatedVoucher?.creditCents} />
                        </button>
                      );
                    })}
                    {/* The custom tile mirrors the presets: the amount sits where their price does. */}
                    <label className={`flex cursor-text flex-col items-center justify-center gap-1 p-4 border bg-[var(--ink-sink)] transition-colors hover:bg-[var(--ink-raise)] focus-within:border-[var(--acid)] ${customDollars && !customValid ? "border-[var(--danger-line)]" : "border-[var(--line)]"}`}>
                      <span className="flex items-baseline text-xl font-bold">
                        <span className={customDollars ? "text-zinc-900" : "text-[var(--fg-faint)]"}>$</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          aria-label="Custom amount"
                          min={customMinCents / 100}
                          max={CUSTOM_TOP_UP.maxCents / 100}
                          step={1}
                          value={customDollars}
                          onChange={(event) => setCustomDollars(event.target.value)}
                          placeholder="Other"
                          style={{ width: `${(customDollars ? customDollars.length : 5) + 0.5}ch` }}
                          className="bg-transparent p-0 text-center text-xl font-bold text-zinc-900 placeholder:text-[var(--fg-faint)] focus-visible:outline-none! [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                        />
                      </span>
                      {customDollars && !customValid ? (
                        <span className="text-xs text-center text-[var(--danger)]">
                          ${customMinCents / 100} to ${(CUSTOM_TOP_UP.maxCents / 100).toLocaleString("en-US")}, whole dollars
                        </span>
                      ) : customValid ? (
                        <GpuTime cents={customCents} bonusCents={validatedVoucher?.creditCents} />
                      ) : (
                        <span className="text-xs text-center text-[var(--muted)]">Type any amount</span>
                      )}
                    </label>
                  </div>
                  {customDollars && (
                    <button
                      type="submit"
                      disabled={topupLoading || !customValid}
                      className="w-full py-3 text-sm font-semibold bg-[var(--acid)] text-[var(--ink)] hover:bg-[var(--acid-deep)] disabled:cursor-not-allowed disabled:bg-[var(--ink-raise)] disabled:text-[var(--fg-faint)] transition-colors"
                    >
                      {customValid ? `Pay $${(customCents / 100).toLocaleString("en-US")}` : "Pay"}
                    </button>
                  )}
                </form>

                <p className="text-xs text-zinc-400 text-center">
                  You&apos;ll be redirected to Stripe to complete payment securely.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function GpuTime({ cents, bonusCents }: { cents: number; bonusCents?: number }) {
  if (!cents) return <span className="text-xs text-center text-[var(--muted)]">Any amount you choose</span>;
  const bonusHours = bonusCents ? gpuHours(bonusCents) : 0;
  return bonusHours
    ? <span className="text-xs text-center text-green-600 font-medium">~{gpuHours(cents) + bonusHours}h GPU time (+{bonusHours}h bonus)</span>
    : <span className="text-xs text-center text-[var(--muted)]">~{gpuHours(cents)}h GPU time</span>;
}
