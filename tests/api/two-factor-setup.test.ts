import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Whoever holds only a login link must not be able to replace a customer's 2FA: that would
// switch it off without a code. The record is shared with admin 2FA under the same email.

const rows = new Map<string, { email: string; secret: string; verified: boolean; backupCodes: string }>();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    twoFactorAuth: {
      findUnique: async ({ where }: { where: { email: string } }) => rows.get(where.email) ?? null,
      upsert: async ({ where, create, update }: { where: { email: string }; create: never; update: object }) => {
        const row = rows.get(where.email);
        rows.set(where.email, row ? { ...row, ...update } : create);
        return rows.get(where.email);
      },
    },
  },
}));
vi.mock('@/lib/customer-auth', () => ({
  verifyCustomerToken: vi.fn(() => ({ email: 'customer@example.com', customerId: 'cus', type: 'customer-dashboard' })),
  generateTwoFactorVerifiedToken: vi.fn(),
}));

import { POST } from '@/app/api/account/two-factor/route';

const setup = () => POST(new NextRequest('http://localhost/api/account/two-factor', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer link-token' },
  body: JSON.stringify({ action: 'setup' }),
}));

describe('POST /api/account/two-factor setup', () => {
  beforeEach(() => rows.clear());

  it('refuses while 2FA is on, and leaves it on', async () => {
    rows.set('customer@example.com', { email: 'customer@example.com', secret: 'OWNER-SECRET', verified: true, backupCodes: '[]' });
    const response = await setup();

    expect(response.status).toBe(409);
    expect(rows.get('customer@example.com')).toMatchObject({ secret: 'OWNER-SECRET', verified: true });
  });

  it('starts setup when 2FA is off', async () => {
    const response = await setup();

    expect(response.status).toBe(200);
    expect((await response.json()).secret).toBeTruthy();
    expect(rows.get('customer@example.com')?.verified).toBe(false);
  });
});
