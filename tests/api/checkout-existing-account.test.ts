import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Counts per key, so the per-email login-link limit is real; the per-IP limit never trips here.
const rateCounts = new Map<string, number>();
vi.mock('@/lib/ratelimit', () => ({
  rateLimit: vi.fn((key: string, opts: { maxRequests: number }) => {
    const n = (rateCounts.get(key) ?? 0) + 1;
    rateCounts.set(key, n);
    return { success: key.startsWith('checkout:') || n <= opts.maxRequests };
  }),
  getClientIp: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('@/lib/embargo', () => ({
  embargoCheck: vi.fn().mockResolvedValue({ blocked: false }),
}));

const stripe = {
  customers: { list: vi.fn(), create: vi.fn() },
  billingPortal: { sessions: { create: vi.fn() } },
  checkout: { sessions: { create: vi.fn() } },
};
vi.mock('@/lib/stripe', () => ({ getStripe: vi.fn(async () => stripe) }));

vi.mock('@/lib/prisma', () => ({
  prisma: { gpuProduct: { findUnique: vi.fn() } },
}));

vi.mock('@/lib/voucher', () => ({
  validateVoucherPublic: vi.fn(async () => ({ valid: true, voucher: { code: 'FREE50', creditCents: 5000 } })),
}));

// A token is just the email it was issued to.
vi.mock('@/lib/customer-auth', () => ({
  generateCustomerToken: vi.fn(() => 'new-token'),
  verifyCustomerToken: vi.fn((token: string) => (token.startsWith('valid:') ? { email: token.slice(6), customerId: 'cus', type: 'customer-dashboard' } : null)),
}));

// Members are allowed unless the test says otherwise.
const gatePermission = vi.fn<(params: unknown) => Promise<Response | null>>(async () => null);
vi.mock('@/lib/auth/gate', () => ({ gatePermission: (params: unknown) => gatePermission(params) }));

const sendLoginEmailForCustomer = vi.fn();
vi.mock('@/lib/customer-login-email', () => ({
  sendLoginEmailForCustomer: (...args: unknown[]) => sendLoginEmailForCustomer(...args),
}));

import { POST } from '@/app/api/checkout/route';
import { prisma } from '@/lib/prisma';

const OWNER = 'customer@example.com';

function checkout(body: Record<string, unknown>, token?: string) {
  return POST(new NextRequest('http://localhost:3000/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ productId: 'prod', email: OWNER, termsAccepted: true, ...body }),
  }));
}

function product(billingType: 'hourly' | 'monthly') {
  vi.mocked(prisma.gpuProduct.findUnique).mockResolvedValue(
    { id: 'prod', name: 'B200', active: true, billingType, stripePriceId: 'price_1', pricePerHourCents: 360 } as never,
  );
}

describe('POST /api/checkout for an email that already has an account', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateCounts.clear();
    product('hourly');
    // Stripe matches the email exactly, as the real API does.
    stripe.customers.list.mockImplementation(async ({ email }: { email: string }) => ({
      data: email === OWNER ? [{ id: 'cus_existing', metadata: { billing_type: 'hourly', hostedai_team_id: 'team_1' } }] : [],
    }));
    stripe.billingPortal.sessions.create.mockResolvedValue({ url: 'https://billing.stripe.com/p/session/secret' });
    stripe.checkout.sessions.create.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/session' });
  });

  it('does not hand the account billing portal to whoever typed the email', async () => {
    const body = await (await checkout({})).json();

    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain('billing.stripe.com');
    expect(body).toMatchObject({ existingAccount: true });
  });

  it('does not open a monthly subscription that would be linked to the account', async () => {
    // The webhook links it to the account by email, and check-ready then logs the payer in.
    product('monthly');
    const body = await (await checkout({})).json();

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(body).toMatchObject({ existingAccount: true });
  });

  it('does not create a voucher account under the email', async () => {
    product('monthly');
    const body = await (await checkout({ voucherCode: 'FREE50' })).json();

    expect(stripe.customers.create).not.toHaveBeenCalled();
    expect(body).toMatchObject({ existingAccount: true });
    expect(body.url).toBeUndefined();
  });

  it('treats a differently-cased email as the same account', async () => {
    product('monthly');
    const body = await (await checkout({ email: '  Customer@Example.COM ' })).json();

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(body).toMatchObject({ existingAccount: true });
  });

  it('refuses a customer logged in as someone else', async () => {
    product('monthly');
    const body = await (await checkout({}, 'valid:attacker@example.com')).json();

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(body).toMatchObject({ existingAccount: true });
  });

  it('lets the logged-in owner subscribe from the dashboard', async () => {
    product('monthly');
    const body = await (await checkout({ source: 'dashboard' }, `valid:${OWNER}`)).json();

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer_email: OWNER }));
    expect(body.url).toBe('https://checkout.stripe.com/c/pay/session');
    expect(sendLoginEmailForCustomer).not.toHaveBeenCalled();
  });

  it('lets a team admin subscribe for the account they are working in', async () => {
    product('monthly');
    const { verifyCustomerToken } = await import('@/lib/customer-auth');
    vi.mocked(verifyCustomerToken).mockReturnValueOnce(
      { email: 'teammate@example.com', customerId: 'cus_own', activeAccountId: 'cus_existing', type: 'customer-dashboard' },
    );
    const body = await (await checkout({ source: 'dashboard' }, 'teammate-token')).json();

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer_email: OWNER }));
    expect(body.url).toBe('https://checkout.stripe.com/c/pay/session');
  });

  it('refuses a team member without billing permission', async () => {
    const { verifyCustomerToken } = await import('@/lib/customer-auth');
    vi.mocked(verifyCustomerToken).mockReturnValueOnce(
      { email: 'viewer@example.com', customerId: 'cus_own', activeAccountId: 'cus_existing', type: 'customer-dashboard' },
    );
    gatePermission.mockResolvedValueOnce(Response.json({ error: 'You do not have permission to perform this action.' }, { status: 403 }));
    const response = await checkout({ source: 'dashboard' }, 'viewer-token');

    expect(response.status).toBe(403);
    expect(gatePermission).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'cus_existing', permission: 'billing.manage' }));
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('refuses a revoked team member', async () => {
    product('monthly');
    const { verifyCustomerToken } = await import('@/lib/customer-auth');
    vi.mocked(verifyCustomerToken).mockReturnValueOnce(
      { email: 'former@example.com', customerId: 'cus_own', activeAccountId: 'cus_existing', type: 'customer-dashboard' },
    );
    gatePermission.mockResolvedValueOnce(Response.json({ error: 'Your access to this account has been revoked.' }, { status: 403 }));
    const response = await checkout({ source: 'dashboard' }, 'former-token');

    expect(response.status).toBe(403);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('checks billing permission on the wallet account too, not only the one the member is working in', async () => {
    stripe.customers.list.mockResolvedValue({ data: [
      { id: 'cus_monthly', metadata: { billing_type: 'monthly' } },
      { id: 'cus_wallet', metadata: { billing_type: 'hourly' } },
    ] });
    const { verifyCustomerToken } = await import('@/lib/customer-auth');
    vi.mocked(verifyCustomerToken).mockReturnValueOnce(
      { email: 'member@example.com', customerId: 'cus_own', activeAccountId: 'cus_monthly', type: 'customer-dashboard' },
    );
    gatePermission.mockImplementation(async (params) => ((params as { accountId: string }).accountId === 'cus_wallet'
      ? Response.json({ error: 'You do not have permission to perform this action.' }, { status: 403 })
      : null));
    const response = await checkout({ source: 'dashboard' }, 'member-token');

    expect(response.status).toBe(403);
    expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
    gatePermission.mockImplementation(async () => null);
  });

  it('finds an older account whose email was saved with capitals', async () => {
    product('monthly');
    stripe.customers.list.mockImplementation(async ({ email }: { email: string }) => ({
      data: email === 'Legacy@Example.com' ? [{ id: 'cus_legacy', metadata: {} }] : [],
    }));
    const body = await (await checkout({ email: 'Legacy@Example.com' })).json();

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(body).toMatchObject({ existingAccount: true });
  });

  it('emails the owner a login link, at most once every few minutes', async () => {
    await checkout({});
    await checkout({});
    await checkout({});

    expect(sendLoginEmailForCustomer).toHaveBeenCalledTimes(1);
    expect(sendLoginEmailForCustomer).toHaveBeenCalledWith(OWNER);
  });

  it('sends no email for an existence check', async () => {
    const body = await (await checkout({ checkOnly: true })).json();

    expect(sendLoginEmailForCustomer).not.toHaveBeenCalled();
    expect(body).toMatchObject({ existingAccount: true });
  });

  it('still answers when the login email fails to send', async () => {
    sendLoginEmailForCustomer.mockRejectedValueOnce(new Error('SMTP down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await checkout({});

    expect(response.status).toBe(200);
    expect((await response.json()).existingAccount).toBe(true);
  });

  it('still lets a new email start a checkout', async () => {
    product('monthly');
    const body = await (await checkout({ email: 'new@example.com' })).json();

    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(expect.objectContaining({ customer_email: 'new@example.com' }));
    expect(body.url).toBe('https://checkout.stripe.com/c/pay/session');
  });
});
