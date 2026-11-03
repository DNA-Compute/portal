import jwt from "jsonwebtoken";
import { getSecret } from "./secrets";
import { sanitizeNextPath } from "./safe-next";
import { prisma } from "@/lib/prisma";

function getJwtSecret(): string {
  return getSecret("CUSTOMER_JWT_SECRET");
}

function getAppUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

export interface CustomerTokenPayload {
  email: string;
  customerId: string;
  type: "customer-dashboard";
  skipTwoFactor?: boolean; // Set to true for admin bypass tokens
  twoFactorVerified?: boolean; // Set after user completes TOTP verification
  // PA-175: optional new-format claims. Tokens issued before PR 2 rolls out
  // won't have these; getAuthenticatedCustomer falls back to email lookup.
  // 1-hour TTL guarantees full rollover within one release cycle.
  userId?: string;          // User.id (cuid)
  activeAccountId?: string; // stripe_customer_id of the account this token is acting on
  // PA-266: post-login redirect (deep-link intent). Sanitized to a same-origin
  // relative /dashboard|/account path at sign time, so it's safe to honour.
  next?: string;
  // PA-266: admin "Login as" impersonation marker. Presence (with skipTwoFactor)
  // keeps the token ephemeral (never persisted to a cookie) and drives the
  // dashboard's impersonation banner + audit attribution.
  impersonator?: { adminEmail: string };
  iat?: number; // Set by jsonwebtoken: when the token was issued, in seconds
}

export interface GenerateCustomerTokenOptions {
  userId?: string;
  activeAccountId?: string;
  expiresInHours?: number;
  /** Deep-link intent to carry through login. Sanitized before signing. */
  next?: string;
  /** The 2FA code was already entered for this sign-in (a session is only created after it). */
  twoFactorVerified?: boolean;
  /** Admin "Login as": keeps the token tab-only and the impersonation banner on. */
  skipTwoFactor?: boolean;
  impersonator?: { adminEmail: string };
}

export function generateCustomerToken(
  email: string,
  customerId: string,
  optionsOrExpires: GenerateCustomerTokenOptions | number = {},
): string {
  // Back-compat: a number argument used to mean expiresInHours. Keep that path.
  const options: GenerateCustomerTokenOptions =
    typeof optionsOrExpires === "number"
      ? { expiresInHours: optionsOrExpires }
      : optionsOrExpires;
  const expiresInHours = options.expiresInHours ?? 1;

  const payload: Record<string, unknown> = {
    email: email.toLowerCase(),
    customerId,
    type: "customer-dashboard",
  };
  if (options.userId) payload.userId = options.userId;
  if (options.activeAccountId) payload.activeAccountId = options.activeAccountId;
  if (options.twoFactorVerified) payload.twoFactorVerified = true;
  if (options.skipTwoFactor) payload.skipTwoFactor = true;
  if (options.impersonator) payload.impersonator = options.impersonator;
  // Sanitize the deep-link target before it goes into the signed token, so a
  // recipient can never rewrite it and the dashboard can honour it as-is.
  const safeNext = sanitizeNextPath(options.next, getAppUrl());
  if (safeNext) payload.next = safeNext;

  return jwt.sign(payload, getJwtSecret(), { expiresIn: `${expiresInHours}h` });
}

/**
 * Generate a customer token that bypasses 2FA.
 * Used by admins for the "Login As" feature.
 */
export function generateAdminBypassToken(email: string, customerId: string, adminEmail?: string): string {
  return jwt.sign(
    {
      email: email.toLowerCase(),
      customerId,
      type: "customer-dashboard",
      skipTwoFactor: true,
      ...(adminEmail ? { impersonator: { adminEmail: adminEmail.toLowerCase() } } : {}),
    },
    getJwtSecret(),
    { expiresIn: "1h" }
  );
}

/**
 * Re-sign a customer token with the twoFactorVerified flag set.
 * Preserves the original token's expiry so the session isn't extended.
 */
export function generateTwoFactorVerifiedToken(originalToken: string): string | null {
  try {
    const decoded = jwt.verify(originalToken, getJwtSecret(), { algorithms: ['HS256'] }) as CustomerTokenPayload & { exp: number };
    if (decoded.type !== "customer-dashboard") return null;

    const remainingSeconds = decoded.exp - Math.floor(Date.now() / 1000);
    if (remainingSeconds <= 0) return null;

    return jwt.sign(
      {
        email: decoded.email,
        customerId: decoded.customerId,
        type: "customer-dashboard",
        twoFactorVerified: true,
        // Preserve every claim that affects identity/intent/isolation. Dropping
        // these caused: (1) an admin "Login as" (skipTwoFactor) token to be
        // laundered into a persistent session, (2) multi-team users to snap to
        // their default account, (3) the deep-link `next` intent to be lost.
        ...(decoded.skipTwoFactor ? { skipTwoFactor: true } : {}),
        ...(decoded.impersonator ? { impersonator: decoded.impersonator } : {}),
        ...(decoded.userId ? { userId: decoded.userId } : {}),
        ...(decoded.activeAccountId ? { activeAccountId: decoded.activeAccountId } : {}),
        ...(decoded.next ? { next: decoded.next } : {}),
      },
      getJwtSecret(),
      { expiresIn: remainingSeconds }
    );
  } catch {
    return null;
  }
}

/**
 * Check a customer token's signature and expiry only, without asking for the 2FA code. Only the
 * routes that finish signing in use this: verify (to learn 2FA is needed), two-factor (to take the
 * code) and logout. Every other route uses verifyCustomerToken.
 */
export function decodeCustomerToken(token: string): CustomerTokenPayload | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as CustomerTokenPayload;
    if (decoded.type !== "customer-dashboard") {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Whether this token still needs the 2FA code before it may be used. A token issued after the user
 * set up 2FA needs it until the code is entered; Login as tokens never do. A token issued before
 * 2FA was set up stays valid, so turning 2FA on doesn't sign the user out.
 */
export async function needsTwoFactorCode(payload: CustomerTokenPayload): Promise<boolean> {
  if (payload.skipTwoFactor || payload.twoFactorVerified) return false;
  const twoFactor = await prisma.twoFactorAuth.findUnique({
    where: { email: payload.email.toLowerCase() },
    select: { verified: true, createdAt: true },
  });
  if (!twoFactor?.verified) return false;
  return (payload.iat ?? 0) >= Math.floor(twoFactor.createdAt.getTime() / 1000);
}

/** Check a customer token, and refuse it while the user's 2FA code is still needed. */
export async function verifyCustomerToken(token: string): Promise<CustomerTokenPayload | null> {
  const payload = decodeCustomerToken(token);
  if (!payload || await needsTwoFactorCode(payload)) return null;
  return payload;
}

/**
 * Generate a long-lived token for drip email unsubscribe links.
 * Valid for 90 days — outlives the drip sequence itself.
 */
export function generateUnsubscribeToken(email: string): string {
  return jwt.sign(
    { email: email.toLowerCase(), type: "drip-unsubscribe" },
    getJwtSecret(),
    { expiresIn: "90d" }
  );
}

/**
 * Verify a drip unsubscribe token.
 */
export function verifyUnsubscribeToken(token: string): { email: string } | null {
  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as { email: string; type: string };
    if (decoded.type !== "drip-unsubscribe") {
      return null;
    }
    return { email: decoded.email };
  } catch {
    return null;
  }
}
