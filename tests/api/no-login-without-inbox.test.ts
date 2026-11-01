import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Whoever pays or types a voucher code has not proved they own the email, so neither path may
// hand back a login. The welcome email carries it instead.

vi.mock('@/lib/ratelimit', () => ({
  rateLimit: vi.fn().mockReturnValue({ success: true }),
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}));
vi.mock('@/lib/embargo', () => ({ embargoCheck: vi.fn().mockResolvedValue({ blocked: false }) }));

const stripe = {
  customers: {
    list: vi.fn(async () => ({ data: [] })),
    create: vi.fn(async () => ({ id: 'cus_new', email: 'new@example.com', metadata: {} })),
    createBalanceTransaction: vi.fn(async () => ({})),
    update: vi.fn(async () => ({ id: 'cus_new', metadata: {} })),
    retrieve: vi.fn(),
  },
  checkout: { sessions: { retrieve: vi.fn() } },
};
vi.mock('@/lib/stripe', () => ({ getStripe: vi.fn(async () => stripe) }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    gpuProduct: { findUnique: vi.fn(async () => ({ id: 'prod', name: 'B200', active: true, billingType: 'hourly', pricePerHourCents: 360 })) },
    voucher: { findUnique: vi.fn(async () => ({ id: 'v1' })), update: vi.fn(() => ({})) },
    voucherRedemption: { create: vi.fn(() => ({})) },
    $transaction: vi.fn(async () => []),
  },
}));
vi.mock('@/lib/voucher', () => ({
  validateVoucherPublic: vi.fn(async () => ({ valid: true, voucher: { code: 'FREE50', creditCents: 5000 } })),
  redeemVoucher: vi.fn(async () => ({})),
}));
vi.mock('@/lib/hostedai', () => ({
  createTeam: vi.fn(async () => ({ id: 'team_new' })),
  createOneTimeLogin: vi.fn(async () => ({})),
  syncTeamsToDefaultPolicy: vi.fn(async () => ({})),
  getDefaultPolicies: vi.fn(async () => ({})),
  ensureRoles: vi.fn(async () => ({ teamAdmin: 'role' })),
}));
const sendWelcomeEmail = vi.fn();
vi.mock('@/lib/email', () => ({ sendWelcomeEmail: (...a: unknown[]) => sendWelcomeEmail(...a) }));
vi.mock('@/lib/customer-cache', () => ({ cacheCustomer: vi.fn(async () => {}) }));
vi.mock('@/lib/referral', () => ({ checkAndProcessReferralQualification: vi.fn(async () => ({ processed: false })) }));
vi.mock('@/lib/edition', () => ({ isPro: () => false, isOSS: () => true }));
vi.mock('@/lib/customer-auth', () => ({
  generateCustomerToken: vi.fn(() => 'LOGIN-TOKEN'),
  verifyCustomerToken: vi.fn(() => null),
}));
vi.mock('@/lib/customer-login-email', () => ({ sendLoginEmailForCustomer: vi.fn() }));

import { POST as checkout } from '@/app/api/checkout/route';
import { GET as checkReady } from '@/app/api/account/check-ready/route';

describe('no login without the inbox', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a full-voucher signup returns no login, and emails it instead', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const response = await checkout(new NextRequest('http://localhost:3000/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'prod', email: 'new@example.com', termsAccepted: true, voucherCode: 'FREE50' }),
    }));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain('LOGIN-TOKEN');
    expect(JSON.parse(text).url).toContain('/success?type=voucher');
    expect(sendWelcomeEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'new@example.com', dashboardUrl: expect.stringContaining('LOGIN-TOKEN'),
    }));
  });

  it('check-ready says the account is ready but returns no login, even for an account linked by email', async () => {
    stripe.checkout.sessions.retrieve.mockResolvedValue({ customer: 'cus_monthly', customer_email: 'customer@example.com', amount_total: 9900 });
    stripe.customers.retrieve.mockImplementation(async (id: string) => (id === 'cus_monthly'
      ? { id, metadata: { primary_stripe_customer_id: 'cus_primary' } }
      : { id, name: 'Account Owner', metadata: { hostedai_team_id: 'team_1' } }));

    const response = await checkReady(new NextRequest('http://localhost:3000/api/account/check-ready?session_id=cs_1'));
    const body = await response.json();

    expect(body.ready).toBe(true);
    expect(JSON.stringify(body)).not.toContain('LOGIN-TOKEN');
    expect(body.dashboardUrl).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('Account Owner');
  });
});
