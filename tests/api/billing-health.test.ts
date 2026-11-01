import { describe, it, expect, vi, beforeEach } from 'vitest';

// The uptime check alerts on anything but 200, so each way billing can go quiet has to answer 503.

const rows = new Map<string, { key: string; value: string }>();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    systemSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => rows.get(where.key) ?? null),
      upsert: vi.fn(async ({ where, create, update }: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
        const value = rows.has(where.key) ? update.value : create.value;
        rows.set(where.key, { key: where.key, value });
      }),
    },
  },
}));

import { recordBillingRun, getBillingHealth } from '@/lib/billing-heartbeat';
import { GET } from '@/app/api/status/billing/route';

const t0 = new Date('2030-01-01T00:00:00Z');
const minutes = (n: number) => new Date(t0.getTime() + n * 60_000);

describe('billing health', () => {
  beforeEach(() => rows.clear());

  it('is down before billing has ever run', async () => {
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, reason: 'never_run' });
  });

  it('is up right after a clean run', async () => {
    await recordBillingRun(0);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, podsErrors: 0 });
  });

  it('goes down once billing has not finished for over 30 minutes', async () => {
    await recordBillingRun(0, t0);
    expect((await getBillingHealth(minutes(30))).ok).toBe(true);
    expect(await getBillingHealth(minutes(31))).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('goes down when a GPU failed to bill, and back up on the next clean run', async () => {
    await recordBillingRun(2, t0);
    expect(await getBillingHealth(minutes(1))).toMatchObject({ ok: false, reason: 'pod_errors', podsErrors: 2 });
    await recordBillingRun(0, minutes(5));
    expect((await getBillingHealth(minutes(6))).ok).toBe(true);
  });

  it('answers 503 when the check itself cannot read the database', async () => {
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.systemSetting.findUnique).mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await GET();
    expect(response.status).toBe(503);
  });
});
