"use client";

import Link from "next/link";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { BrandLogo } from "@/components/BrandLogo";
import { getBrandName, getLogoUrl, getSupportEmail } from "@/lib/branding-client";
import { useBranding } from "@/hooks/useBranding";

// Analytics globals the LinkedIn and Growify snippets add to the page.
type TrackingWindow = {
  lintrk?: (...args: unknown[]) => void;
  grp?: (...args: unknown[]) => void;
  grpQueue?: unknown[];
};

function SuccessContent() {
  const searchParams = useSearchParams();
  const branding = useBranding();
  const LOGO_URL = branding?.logoUrl || getLogoUrl();
  const [mounted, setMounted] = useState(false);
  const [accountReady, setAccountReady] = useState(false);
  const [pollFailed, setPollFailed] = useState(false);
  const type = searchParams.get("type");
  const email = searchParams.get("email");
  const sessionId = searchParams.get("session_id");
  const isFreeTrial = type === "free-trial" || type === "free";
  const isVoucher = type === "voucher";
  const isExistingUser = type === "existing";

  useEffect(() => {
    setMounted(true);
  }, []);

  // A voucher signup is set up before this page loads; its login link is in the welcome email.
  useEffect(() => {
    if (isVoucher) setAccountReady(true);
  }, [isVoucher]);

  // Poll until the account is ready, then tell the customer to use the emailed link.
  // Uses session_id (from Stripe checkout redirect) for secure verification
  useEffect(() => {
    if (!sessionId || isFreeTrial) return;

    let attempts = 0;
    const maxAttempts = 15; // 30 seconds at 2s intervals
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        const res = await fetch(`/api/account/check-ready?session_id=${encodeURIComponent(sessionId)}`);
        const data = await res.json();

        if (data.ready) {
          stopped = true;
          clearInterval(intervalId);
          setAccountReady(true);
          const tracking = window as unknown as TrackingWindow;
          if (typeof tracking.lintrk === "function") {
            tracking.lintrk("track", { conversion_id: 24436340 });
          }
          // Growify v2 conversion — new signup with first payment
          try {
            const amountDollars = (data.amountCents || 0) / 100;
            const price = amountDollars > 0 ? amountDollars : 50;
            const w = tracking;
            const queue = (w.grpQueue = w.grpQueue || []);
            if (!w.grp) { w.grp = (...args: unknown[]) => { queue.push(args); }; }
            w.grp('conversion', {
              userEmail: data.email || email || '',
              userFirstName: '',
              userLastName: '',
              userId: '',
              orderId: sessionId || '',
              tax: 0,
              shipping: 0,
              products: [{
                productId: "signup-deposit",
                productName: "Initial Wallet Deposit",
                productPrice: price,
                productBrand: "gpu-cloud",
                productQuantity: 1,
                purchaseValue: price,
              }],
            });
          } catch { /* Growify not loaded */ }
          return;
        }
      } catch {
        // Ignore polling errors
      }

      attempts++;
      if (attempts >= maxAttempts) {
        stopped = true;
        clearInterval(intervalId);
        setPollFailed(true);
      }
    };

    // Start the timer before the first poll, so a poll that finishes can always clear it.
    const intervalId = setInterval(poll, 2000);
    poll();

    return () => {
      stopped = true;
      clearInterval(intervalId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, isFreeTrial]);

  return (
    <div className="min-h-screen bg-white text-zinc-900 flex flex-col">
      {/* Header */}
      <header className="border-b border-zinc-100 bg-white/80 backdrop-blur-sm sticky top-0 z-40">
        <div className="mx-auto max-w-6xl px-6 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center">
            <BrandLogo
              src={LOGO_URL}
              alt={getBrandName()}
              width={120}
              height={32}
              className="h-7 w-auto"
            />
          </Link>
        </div>
      </header>

      {/* Progress */}
      <div className="border-b border-zinc-100">
        <div className="mx-auto max-w-xl px-6 py-4">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-zinc-50 text-white flex items-center justify-center">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
            <div className="flex-1 h-px bg-zinc-50 mx-3" />
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-zinc-50 text-white flex items-center justify-center">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
            <div className="flex-1 h-px bg-zinc-50 mx-3" />
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-zinc-50 text-white flex items-center justify-center">
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-grow flex items-center justify-center py-16">
        <div className="max-w-md text-center px-6">
          {/* Success Icon */}
          <div className={`w-16 h-16 bg-zinc-50 rounded-full flex items-center justify-center mx-auto mb-8 transition-all duration-500 ${mounted ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`}>
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>

          <h1 className="text-3xl font-bold tracking-tight mb-3">
            {isExistingUser
              ? "Check your email"
              : isFreeTrial
              ? "Your free account is ready!"
              : `Welcome to ${getBrandName()}`}
          </h1>

          <p className="text-zinc-500 mb-10">
            {isExistingUser
              ? "We sent you a login link. Click it to access your dashboard."
              : isFreeTrial
              ? "Check your email for your API key and dashboard link."
              : isVoucher
              ? "Your voucher has been applied."
              : "Your payment was successful. Your GPU dashboard is being set up now."}
          </p>

          {/* Steps - Dynamic based on account readiness */}
          {accountReady ? (
            <div className="mb-10">
              <div className="p-6 bg-[var(--ok-fill)] border border-[var(--ok-line)] rounded-xl">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0">
                    <svg className="w-4 h-4 text-[var(--ink)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <p className="font-semibold text-[var(--ok)]">Your account is ready!</p>
                </div>
                <p className="text-sm text-[var(--fg-muted)] ml-11">
                  We&apos;ve emailed your login link{email ? ` to ${email}` : ""}. Click it to open your dashboard.
                </p>
              </div>
            </div>
          ) : (
            <div className="text-left mb-10">
              <div className="space-y-4">
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center flex-shrink-0">
                    {sessionId && !isFreeTrial && !pollFailed ? (
                      <div className="w-4 h-4 border-2 border-zinc-300 border-t-zinc-900 rounded-full animate-spin" />
                    ) : (
                      <span className="text-sm font-medium text-zinc-900">1</span>
                    )}
                  </div>
                  <div className="pt-1">
                    <p className="font-medium text-zinc-900">
                      {sessionId && !isFreeTrial && !isExistingUser && !pollFailed ? "Setting up your account..." : "Check your email"}
                    </p>
                    <p className="text-sm text-zinc-500">
                      {isExistingUser
                        ? `We sent a login link${email ? ` to ${email}` : ""}`
                        : isFreeTrial
                        ? `We sent your API key and login link${email ? ` to ${email}` : ""}`
                        : pollFailed
                        ? "We're sending you a login link"
                        : sessionId
                        ? "This usually takes about 10 seconds"
                        : "We're sending you a login link"}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center flex-shrink-0 text-sm font-medium text-zinc-900">
                    2
                  </div>
                  <div className="pt-1">
                    <p className="font-medium text-zinc-900">
                      Click the link
                    </p>
                    <p className="text-sm text-zinc-500">
                      No password needed
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-4">
                  <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center flex-shrink-0 text-sm font-medium text-zinc-900">
                    3
                  </div>
                  <div className="pt-1">
                    <p className="font-medium text-zinc-900">
                      {isExistingUser
                        ? "Access your dashboard"
                        : isFreeTrial
                        ? "Browse the GPU inventory"
                        : "Launch your first GPU"}
                    </p>
                    <p className="text-sm text-zinc-500">
                      {isExistingUser
                        ? "Your account and data are right where you left them"
                        : isFreeTrial
                        ? "See what's available and pick a pod when you're ready to deploy"
                        : "Start deploying in minutes — browse the inventory and pick a pod"}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Free trial upgrade prompt */}
          {isFreeTrial && (
            <div className="p-4 bg-[var(--warn-fill)] border border-[var(--warn-line)] rounded-lg mb-4 text-sm text-[var(--warn)]">
              <span className="font-medium">Want GPU pods?</span> Add $50 to your wallet to unlock dedicated GPU instances for training, fine-tuning, and more.
            </div>
          )}

          {/* Notice */}
          <div className="p-4 bg-zinc-50 rounded-lg mb-8 text-sm text-zinc-600">
            <span className="font-medium">Didn&apos;t get the email?</span> Check your spam folder or request a new link.
          </div>

          {/* Actions */}
          <div className="flex flex-col items-center gap-4">
            <Link
              href="/account"
              className="px-6 py-3 bg-zinc-50 hover:bg-zinc-100 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Resend Login Link
            </Link>
            <p className="text-sm text-zinc-500">
              Need help? Reach us at{" "}
              <a
                href={`mailto:${branding?.supportEmail || getSupportEmail()}`}
                className="font-medium text-zinc-700 hover:text-zinc-900 transition-colors"
              >
                {branding?.supportEmail || getSupportEmail()}
              </a>
            </p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-zinc-100">
        <div className="mx-auto max-w-6xl px-6 py-6">
          <p className="text-center text-xs text-zinc-400">
            &copy; {new Date().getFullYear()} {getBrandName()} &middot; Powered by{" "}
            <a href="https://hosted.ai" className="hover:text-zinc-600 transition-colors" target="_blank" rel="noopener noreferrer">
              hosted.ai
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}

function SuccessLoading() {
  return (
    <div className="min-h-screen bg-white text-zinc-900 flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-zinc-200 border-t-zinc-900 rounded-full animate-spin" />
    </div>
  );
}

export default function SuccessPage() {
  return (
    <Suspense fallback={<SuccessLoading />}>
      <SuccessContent />
    </Suspense>
  );
}
