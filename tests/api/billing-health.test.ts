import { describe, it, expect, vi, beforeEach } from 'vitest';

// The uptime check alerts on anything but 200, so each way billing can go quiet has to answer 503.

const rows = new Map<string, { key: string; value: string }>();
type Pod = { subscriptionId: string; instanceId: string | null; prepaidUntil: Date | null; hourlyRateCents: number | null; billingType: string | null };
let pods: Pod[] = [];
let instances: Array<{ id: string; status: string; created_at: string }> | Error = [];
vi.mock('@/lib/hostedai/instances', () => ({
  getAllUnifiedInstances: vi.fn(async () => { if (instances instanceof Error) throw instances; return instances; }),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    podMetadata: {
      findMany: vi.fn(async () => pods.map(({ subscriptionId, instanceId }) => ({ subscriptionId, instanceId }))),
      // Mirrors the one query getBillingHealth makes: hourly GPUs paid up to before the cutoff.
      count: vi.fn(async ({ where }: { where: { prepaidUntil: { lt: Date } } }) => pods.filter(p =>
        p.prepaidUntil !== null && p.prepaidUntil < where.prepaidUntil.lt && (p.hourlyRateCents ?? 0) > 0 && p.billingType !== 'monthly'
      ).length),
    },
    systemSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => rows.get(where.key) ?? null),
      upsert: vi.fn(async ({ where, create, update }: { where: { key: string }; create: { value: string }; update: { value: string } }) => {
        const value = rows.has(where.key) ? update.value : create.value;
        rows.set(where.key, { key: where.key, value });
      }),
    },
  },
}));

import { recordBillingRun, getBillingHealth, countUntrackedGpus } from '@/lib/billing-heartbeat';
import { GET } from '@/app/api/status/billing/route';

const t0 = new Date('2030-01-01T00:00:00Z');
const minutes = (n: number) => new Date(t0.getTime() + n * 60_000);

describe('billing health', () => {
  beforeEach(() => { rows.clear(); pods = []; instances = []; });

  it('is down before billing has ever run', async () => {
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, reason: 'never_run' });
  });

  it('is up right after a clean run', async () => {
    await recordBillingRun({ podsErrors: 0, untrackedGpus: 0 });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, podsErrors: 0 });
  });

  it('goes down once billing has not finished for over 30 minutes', async () => {
    await recordBillingRun({ podsErrors: 0, untrackedGpus: 0 }, t0);
    expect((await getBillingHealth(minutes(30))).ok).toBe(true);
    expect(await getBillingHealth(minutes(31))).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('goes down when a GPU failed to bill, and back up on the next clean run', async () => {
    await recordBillingRun({ podsErrors: 2, untrackedGpus: 0 }, t0);
    expect(await getBillingHealth(minutes(1))).toMatchObject({ ok: false, reason: 'pod_errors', podsErrors: 2 });
    await recordBillingRun({ podsErrors: 0, untrackedGpus: 0 }, minutes(5));
    expect((await getBillingHealth(minutes(6))).ok).toBe(true);
  });

  it('goes down when an hourly GPU has not been paid for in over an hour', async () => {
    await recordBillingRun({ podsErrors: 0, untrackedGpus: 0 }, t0);
    pods = [{ subscriptionId: 'instance-a', instanceId: 'a', prepaidUntil: minutes(-59), hourlyRateCents: 360, billingType: 'hourly' }];
    expect((await getBillingHealth(minutes(0))).ok).toBe(true);
    expect(await getBillingHealth(minutes(2))).toMatchObject({ ok: false, reason: 'billing_behind', gpusBehind: 1 });
  });

  it('ignores monthly GPUs, which are paid for by subscription', async () => {
    await recordBillingRun({ podsErrors: 0, untrackedGpus: 0 }, t0);
    pods = [{ subscriptionId: 'instance-a', instanceId: 'a', prepaidUntil: minutes(-600), hourlyRateCents: 360, billingType: 'monthly' }];
    expect((await getBillingHealth(minutes(1))).ok).toBe(true);
  });

  it('goes down when hosted.ai cannot be reached, since GPUs can then be neither billed nor stopped', async () => {
    instances = new Error('connect timeout');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await recordBillingRun({ podsErrors: 0, untrackedGpus: await countUntrackedGpus(t0) }, t0);
    expect(await getBillingHealth(minutes(1))).toMatchObject({ ok: false, reason: 'hosted_ai_unreachable' });
  });

  it('goes down for a hosted.ai GPU the portal has no billing record for', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    pods = [{ subscriptionId: 'instance-known', instanceId: 'known', prepaidUntil: minutes(30), hourlyRateCents: 360, billingType: 'hourly' }];
    instances = [
      { id: 'known', status: 'running', created_at: minutes(-120).toISOString() },
      { id: 'from-their-panel', status: 'running', created_at: minutes(-120).toISOString() },
      { id: 'launching-now', status: 'pending', created_at: minutes(-5).toISOString() },
    ];
    expect(await countUntrackedGpus(t0)).toBe(1);
    await recordBillingRun({ podsErrors: 0, untrackedGpus: 1 }, t0);
    expect(await getBillingHealth(minutes(1))).toMatchObject({ ok: false, reason: 'untracked_gpus', untrackedGpus: 1 });
  });

  it('answers 503 when the check itself cannot read the database', async () => {
    const { prisma } = await import('@/lib/prisma');
    vi.mocked(prisma.systemSetting.findUnique).mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await GET();
    expect(response.status).toBe(503);
  });
});
