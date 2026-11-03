import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { generateCustomerToken } from '@/lib/auth/customer';

const TEST_CUSTOMER_ID = 'cus_budget_test';
const TEST_EMAIL = 'budget@example.com';
// The account being worked in, which differs from the token's own account for a team member.
const ACTIVE_ACCOUNT_ID = 'cus_team_owner';

// Mock Prisma
const mockFindUnique = vi.fn();
const mockUpsert = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    budgetSettings: {
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
      upsert: (...args: unknown[]) => mockUpsert(...args),
    },
    teamAuditLog: { create: vi.fn().mockResolvedValue({}) },
  },
}));

// The caller's permissions on the active account.
const perms = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth/helpers', async () => {
  const { NextResponse } = await import('next/server');
  const { decodeCustomerToken } = await import('@/lib/auth/customer');
  return {
    getAuthenticatedCustomer: async (request: NextRequest) => {
      const token = request.headers.get('authorization')?.replace('Bearer ', '');
      const payload = token ? decodeCustomerToken(token) : null;
      if (!payload) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      return {
        payload,
        accountId: ACTIVE_ACCOUNT_ID,
        membership: { userId: 'user_1', role: 'readOnlyMember', isOwner: false },
        can: (permission: string) => perms.granted.has(permission),
      };
    },
  };
});

import { GET, PUT } from '@/app/api/account/budget/route';

describe('/api/account/budget', () => {
  let validToken: string;

  beforeEach(() => {
    vi.clearAllMocks();
    perms.granted = new Set(['billing.view', 'billing.manage']);
    validToken = generateCustomerToken(TEST_EMAIL, TEST_CUSTOMER_ID);
  });

  describe('team permissions', () => {
    it('refuses a member without billing.manage, and changes nothing', async () => {
      perms.granted = new Set(['billing.view']);
      const response = await PUT(
        makePutRequest({ monthlyLimitCents: 1, autoShutdownEnabled: true }, validToken)
      );
      expect(response.status).toBe(403);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('refuses to show the budget without billing.view', async () => {
      perms.granted = new Set();
      const response = await GET(makeGetRequest(validToken));
      expect(response.status).toBe(403);
      expect(mockFindUnique).not.toHaveBeenCalled();
    });

    it('reads and writes the account being worked in, not the account in the token', async () => {
      mockFindUnique.mockResolvedValue(null);
      await GET(makeGetRequest(validToken));
      expect(mockFindUnique).toHaveBeenCalledWith({ where: { stripeCustomerId: ACTIVE_ACCOUNT_ID } });

      mockUpsert.mockResolvedValue({ monthlyLimitCents: 500 });
      await PUT(makePutRequest({ monthlyLimitCents: 500 }, validToken));
      expect(mockUpsert.mock.calls[0][0].where).toEqual({ stripeCustomerId: ACTIVE_ACCOUNT_ID });
      expect(mockUpsert.mock.calls[0][0].create.stripeCustomerId).toBe(ACTIVE_ACCOUNT_ID);
    });
  });

  function makeGetRequest(token?: string): NextRequest {
    const headers: Record<string, string> = {};
    if (token) {
      headers['authorization'] = `Bearer ${token}`;
    }
    return new NextRequest('http://localhost:3000/api/account/budget', {
      method: 'GET',
      headers,
    });
  }

  function makePutRequest(body: unknown, token?: string): NextRequest {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['authorization'] = `Bearer ${token}`;
    }
    return new NextRequest('http://localhost:3000/api/account/budget', {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
  }

  describe('GET', () => {
    it('should return 401 without auth token', async () => {
      const response = await GET(makeGetRequest());
      expect(response.status).toBe(401);
    });

    it('should return 401 with invalid token', async () => {
      const response = await GET(makeGetRequest('bad-token'));
      expect(response.status).toBe(401);
    });

    it('should return default settings when none exist', async () => {
      mockFindUnique.mockResolvedValue(null);

      const response = await GET(makeGetRequest(validToken));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.monthlyLimitCents).toBeNull();
      expect(body.dailyLimitCents).toBeNull();
      expect(body.alertAt50Percent).toBe(true);
      expect(body.alertAt80Percent).toBe(true);
      expect(body.alertAt100Percent).toBe(true);
      expect(body.autoShutdownEnabled).toBe(false);
      expect(body.autoShutdownThreshold).toBe(100);
    });

    it('should return saved settings when they exist', async () => {
      mockFindUnique.mockResolvedValue({
        monthlyLimitCents: 50000,
        dailyLimitCents: 5000,
        alertAt50Percent: false,
        alertAt80Percent: true,
        alertAt100Percent: true,
        autoShutdownEnabled: true,
        autoShutdownThreshold: 80,
      });

      const response = await GET(makeGetRequest(validToken));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.monthlyLimitCents).toBe(50000);
      expect(body.autoShutdownEnabled).toBe(true);
      expect(body.autoShutdownThreshold).toBe(80);
    });
  });

  describe('PUT', () => {
    it('should return 401 without auth token', async () => {
      const response = await PUT(makePutRequest({ monthlyLimitCents: 10000 }));
      expect(response.status).toBe(401);
    });

    it('should update budget settings with valid input', async () => {
      const savedSettings = {
        monthlyLimitCents: 50000,
        dailyLimitCents: null,
        alertAt50Percent: true,
        alertAt80Percent: true,
        alertAt100Percent: true,
        autoShutdownEnabled: false,
        autoShutdownThreshold: 100,
      };
      mockUpsert.mockResolvedValue(savedSettings);

      const response = await PUT(
        makePutRequest({ monthlyLimitCents: 50000 }, validToken)
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.settings.monthlyLimitCents).toBe(50000);
    });

    it('should reject negative monthly limit', async () => {
      const response = await PUT(
        makePutRequest({ monthlyLimitCents: -100 }, validToken)
      );
      expect(response.status).toBe(400);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('should reject non-integer monthly limit', async () => {
      const response = await PUT(
        makePutRequest({ monthlyLimitCents: 99.5 }, validToken)
      );
      expect(response.status).toBe(400);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('should reject auto-shutdown threshold below 50', async () => {
      const response = await PUT(
        makePutRequest({ autoShutdownThreshold: 30 }, validToken)
      );
      expect(response.status).toBe(400);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('should reject auto-shutdown threshold above 100', async () => {
      const response = await PUT(
        makePutRequest({ autoShutdownThreshold: 150 }, validToken)
      );
      expect(response.status).toBe(400);
      expect(mockUpsert).not.toHaveBeenCalled();
    });

    it('should accept null monthly limit (removes limit)', async () => {
      const savedSettings = {
        monthlyLimitCents: null,
        dailyLimitCents: null,
        alertAt50Percent: true,
        alertAt80Percent: true,
        alertAt100Percent: true,
        autoShutdownEnabled: false,
        autoShutdownThreshold: 100,
      };
      mockUpsert.mockResolvedValue(savedSettings);

      const response = await PUT(
        makePutRequest({ monthlyLimitCents: null }, validToken)
      );
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.settings.monthlyLimitCents).toBeNull();
    });

    it('should accept valid auto-shutdown threshold at boundary', async () => {
      const savedSettings = {
        monthlyLimitCents: null,
        dailyLimitCents: null,
        alertAt50Percent: true,
        alertAt80Percent: true,
        alertAt100Percent: true,
        autoShutdownEnabled: true,
        autoShutdownThreshold: 50,
      };
      mockUpsert.mockResolvedValue(savedSettings);

      const response = await PUT(
        makePutRequest(
          { autoShutdownEnabled: true, autoShutdownThreshold: 50 },
          validToken
        )
      );
      expect(response.status).toBe(200);
    });

    it('should reject string value for boolean field', async () => {
      const response = await PUT(
        makePutRequest({ alertAt50Percent: 'yes' }, validToken)
      );
      expect(response.status).toBe(400);
      expect(mockUpsert).not.toHaveBeenCalled();
    });
  });
});
