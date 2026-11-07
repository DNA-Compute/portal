"use client";

import { useEffect, useState } from "react";
import { endLoginAs } from "./hooks/useDashboardData";

/** When the session token stops working, read from its own expiry claim; null if it has none. */
function tokenEndsAt(token: string | null): Date | null {
  try {
    const claims = JSON.parse(atob(token!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof claims.exp === "number" ? new Date(claims.exp * 1000) : null;
  } catch {
    return null;
  }
}

/**
 * Sticky bar shown only in an admin "Login as" (impersonation) session, so the
 * admin always knows whose account they're acting in. The real customer never
 * sees it — impersonation rides an ephemeral, tab-scoped token (no cookie, kept in
 * sessionStorage so a reload stays in the session), so
 * skipTwoFactor is only ever true in the admin's impersonation tab.
 */
export function ImpersonationBanner({
  customerEmail,
  adminEmail,
  token,
}: {
  customerEmail: string;
  adminEmail?: string | null;
  token: string | null;
}) {
  // Login as lasts an hour and then signs out mid-action, so say when it ends.
  const endsAt = tokenEndsAt(token);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const minutesLeft = endsAt ? Math.max(0, Math.ceil((endsAt.getTime() - now) / 60_000)) : null;

  return (
    <div className="sticky top-0 z-[70] flex items-center justify-center gap-3 bg-amber-500 px-4 py-2 text-center text-sm font-medium text-amber-950 shadow">
      <span>
        ⚠ You are logged in as <strong>{customerEmail}</strong> using the
        &ldquo;Login as&rdquo; feature
        {adminEmail ? (
          <>
            {" "}from <strong>{adminEmail}</strong>&apos;s account
          </>
        ) : null}
        . Actions affect this customer&apos;s account.
        {endsAt && minutesLeft !== null ? (
          <>
            {" "}
            <span className={minutesLeft <= 5 ? "font-bold underline" : undefined}>
              Ends at {endsAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              {minutesLeft <= 5 ? ` (${minutesLeft} min left; use Login as again to continue)` : ""}
            </span>
            .
          </>
        ) : null}
      </span>
      <button
        type="button"
        onClick={() => {
          endLoginAs();
          try {
            window.close();
          } catch {
            /* not script-opened */
          }
          window.location.href = "/admin";
        }}
        className="shrink-0 rounded bg-amber-950/10 px-2 py-0.5 font-semibold text-amber-950 hover:bg-amber-950/20"
      >
        Exit
      </button>
    </div>
  );
}
