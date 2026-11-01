import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Billing ran for the first time on DNA in 2026-10: until then every GPU was charged its first
// 30 minutes only. These tests drive /api/sync against in-memory Stripe, PodMetadata and hosted.ai
// fakes, covering what has to hold once it runs every 5 minutes on prod.

vi.hoisted(() => { process.env.CRON_SECRET = "sync-billing-test"; });

const BLOCK_MS = 30 * 60_000;
const NOW = new Date("2030-01-01T12:00:00Z").getTime();

type Customer = { id: string; balance: number; email: string; metadata: Record<string, string> };
type Pod = {
  subscriptionId: string; instanceId: string; stripeCustomerId: string; poolId: string;
  hourlyRateCents: number; hourlyRateBasis: string; billingType: string | null;
  prepaidUntil: Date | null; prepaidAmountCents: number | null; rateSnapshot: null; launchConfiguration: null;
};
type Sub = { id: string; status: string; pods: Array<{ pod_status: string }>; per_pod_info: { vgpu_count: number } };

const state = vi.hoisted(() => ({
  customers: new Map<string, Customer>(),
  pods: [] as Pod[],
  subs: new Map<string, Sub[]>(),
  charges: [] as Array<{ customerId: string; amount: number; key?: string; description: string; metadata?: Record<string, string> }>,
  keyedAmounts: new Map<string, number>(),
  failNextCharge: false,
  failNextLookup: false,
  walletRows: [] as Array<{ type: string; amountCents: number; billingMinutes?: number; metadata?: string }>,
  storagePrice: 0,
  volumes: new Map<string, Array<{ id: number; team_id: string; size_in_gb: number }>>(),
  poolCache: null as null | { pools: Array<{ id: number; name: string; pods: Array<{ teamId: string; status: string }> }> },
}));
const mocks = vi.hoisted(() => ({ refill: vi.fn(), deleteInstance: vi.fn(), deleteVolume: vi.fn() }));

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const sameTime = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

vi.mock("@/lib/prisma", () => ({ prisma: {
  customerCache: {
    findMany: async () => [...state.customers.keys()].map(id => ({ id })),
    findFirst: async () => {
      const c = [...state.customers.values()][0];
      return c && { id: c.id, teamId: c.metadata.hostedai_team_id, email: c.email, billingType: c.metadata.billing_type };
    },
    update: async () => ({}),
  },
  walletTransaction: { create: async ({ data }: { data: { type: string; amountCents: number; billingMinutes?: number; metadata?: string } }) => { state.walletRows.push(data); return {}; } },
  gpuProduct: { findMany: async () => [] },
  podMetadata: {
    findMany: async ({ where }: { where: Record<string, unknown> }) => {
      await tick();
      const text = JSON.stringify(where);
      return state.pods.filter(p =>
        (!where.stripeCustomerId || p.stripeCustomerId === where.stripeCustomerId)
        && (!text.includes("monthly") || p.billingType !== "monthly")
        && (!text.includes("prepaidUntil") || p.prepaidUntil === null || p.prepaidUntil.getTime() <= Date.now()),
      ).map(p => ({ ...p }));
    },
    updateMany: async ({ where, data }: { where: { subscriptionId: string; prepaidUntil: Date | null }; data: Partial<Pod> }) => {
      await tick();
      const rows = state.pods.filter(p => p.subscriptionId === where.subscriptionId && sameTime(p.prepaidUntil, where.prepaidUntil));
      rows.forEach(p => Object.assign(p, data));
      return { count: rows.length };
    },
    update: async () => ({}),
    create: async () => ({}),
    findUnique: async () => null,
    count: async ({ where }: { where: { stripeCustomerId: string } }) => state.pods.filter(p => p.stripeCustomerId === where.stripeCustomerId).length,
  },
} }));

vi.mock("@/lib/stripe", () => ({ getStripe: async () => ({ customers: {
  retrieve: async (id: string) => ({ ...state.customers.get(id)! }),
  update: async (id: string, { metadata }: { metadata: Record<string, string> }) => {
    const c = state.customers.get(id)!;
    c.metadata = { ...c.metadata, ...metadata };
    return { ...c };
  },
  listBalanceTransactions: async (customerId: string) => {
    if (state.failNextLookup) { state.failNextLookup = false; throw new Error("Stripe unavailable"); }
    return { data: state.charges.filter(c => c.customerId === customerId).reverse() };
  },
  createBalanceTransaction: async (customerId: string, params: { amount: number; description: string; metadata?: Record<string, string> }, opts?: { idempotencyKey?: string }) => {
    await tick();
    const key = opts?.idempotencyKey;
    if (key && state.keyedAmounts.has(key)) {
      if (state.keyedAmounts.get(key) !== params.amount) throw Object.assign(new Error("Keys for idempotent requests can only be used with the same parameters"), { type: "StripeIdempotencyError" });
      return {};
    }
    if (state.failNextCharge) { state.failNextCharge = false; throw new Error("Stripe unavailable"); }
    if (key) state.keyedAmounts.set(key, params.amount);
    state.customers.get(customerId)!.balance += params.amount;
    state.charges.push({ customerId, amount: params.amount, key, description: params.description, metadata: params.metadata });
    return {};
  },
} }) }));

vi.mock("@/lib/hostedai", () => ({
  getPoolSubscriptions: async (teamId: string) => state.subs.get(teamId) ?? [],
  getSharedVolumes: async (teamId: string) => state.volumes.get(teamId) ?? [],
  deleteSharedVolume: mocks.deleteVolume,
  deleteInstance: mocks.deleteInstance,
}));
vi.mock("@/lib/wallet", () => ({ checkAndRefillWallet: mocks.refill, WALLET_CONFIG: {} }));
vi.mock("@/lib/pricing", () => ({ getStoragePricePerGBHourCents: () => state.storagePrice, getStoppedInstanceRatePercent: () => 25 }));
vi.mock("@/lib/customer-cache", () => ({ cacheCustomer: async () => undefined }));
vi.mock("@/lib/pool-overview", () => ({ readPoolOverviewCache: () => state.poolCache }));
vi.mock("@/lib/email", () => ({ sendNegativeBalanceShutdownEmail: vi.fn() }));

import { POST } from "@/app/api/sync/route";

const sync = () => POST(new NextRequest("http://localhost/api/sync", {
  method: "POST", headers: { authorization: "Bearer sync-billing-test" },
}));

function addCustomer(id: string, balance = 0, metadata: Record<string, string> = {}) {
  state.customers.set(id, { id, balance, email: `${id}@example.com`, metadata: { hostedai_team_id: "team", billing_type: "hourly", ...metadata } });
}

/** A running GPU at $6/hr ($3 per 30-minute block). */
function addGpu(id: string, prepaidUntil: Date | null, overrides: Partial<Pod> = {}) {
  state.pods.push({
    subscriptionId: `instance-${id}`, instanceId: id, stripeCustomerId: "cus", poolId: "15",
    hourlyRateCents: 600, hourlyRateBasis: "per_gpu", billingType: "hourly",
    prepaidUntil, prepaidAmountCents: 300, rateSnapshot: null, launchConfiguration: null, ...overrides,
  });
  const subs = state.subs.get("team") ?? [];
  subs.push({ id, status: "active", pods: [{ pod_status: "running" }], per_pod_info: { vgpu_count: 1 } });
  state.subs.set("team", subs);
}

const pod = (id: string) => state.pods.find(p => p.instanceId === id)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "log").mockImplementation(() => {});
  state.customers.clear(); state.pods = []; state.subs.clear(); state.charges = [];
  state.keyedAmounts.clear(); state.failNextCharge = false; state.storagePrice = 0; state.volumes.clear(); state.poolCache = null;
  state.failNextLookup = false; state.walletRows = [];
  mocks.refill.mockReset().mockResolvedValue({ refilled: false });
  mocks.deleteInstance.mockReset().mockResolvedValue(undefined);
  mocks.deleteVolume.mockReset();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("/api/sync GPU billing", () => {
  it("charges every 30-minute block since the GPU's paid-up time in one charge", async () => {
    // Paid up until exactly 5 hours ago: the 10 blocks since, plus the one starting now.
    addCustomer("cus", -10_000);
    addGpu("gpu", new Date(NOW - 5 * 3_600_000));
    expect((await sync()).status).toBe(200);
    expect(state.charges).toEqual([expect.objectContaining({ customerId: "cus", amount: 11 * 300, key: `pod_instance-gpu_${(NOW - 5 * 3_600_000) / 1000}` })]);
    expect(state.charges[0].description).toContain("330 mins");
    expect(pod("gpu").prepaidUntil).toEqual(new Date(NOW + BLOCK_MS));
    expect(pod("gpu").prepaidAmountCents).toBe(300);
  });

  it("holds more than 6 hours of unbilled time for manual settlement and bills on from now", async () => {
    // Priced at today's state, a long backlog could charge for weeks the GPU was stopped or resized.
    addCustomer("cus", -10_000);
    const paidUntil = new Date(NOW - 24 * 3_600_000);
    addGpu("gpu", paidUntil);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const body = await (await sync()).json();
    expect(state.charges.map(c => c.amount)).toEqual([300]);
    expect(pod("gpu").prepaidUntil).toEqual(new Date(NOW + BLOCK_MS));
    expect(state.walletRows).toContainEqual(expect.objectContaining({ type: "held_backlog", amountCents: 0, billingMinutes: 24 * 60 }));
    expect(body.summary.backlogsHeld).toBe(1);
    expect(body.heldBacklogs[0]).toMatchObject({ minutes: 24 * 60, estimatedCents: 48 * 300, from: paidUntil.toISOString() });
  });

  it("releases the blocks when Stripe cannot be asked about earlier charges", async () => {
    addCustomer("cus", -10_000);
    const paidUntil = new Date(NOW - 1000);
    addGpu("gpu", paidUntil);
    state.failNextLookup = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    await sync();
    expect(state.charges).toHaveLength(0);
    expect(pod("gpu").prepaidUntil).toEqual(paidUntil);
    await sync();
    expect(state.charges).toHaveLength(1);
  });

  it("does not charge again before the next block starts", async () => {
    addCustomer("cus", -10_000);
    addGpu("gpu", new Date(NOW - 1000));
    await sync();
    vi.setSystemTime(NOW + 25 * 60_000);
    await sync();
    vi.setSystemTime(NOW + 31 * 60_000);
    await sync();
    expect(state.charges.map(c => c.amount)).toEqual([300, 300]);
  });

  it("charges a block once when two billing runs overlap", async () => {
    addCustomer("cus", -10_000);
    addGpu("gpu", new Date(NOW - 1000));
    await Promise.all([sync(), sync()]);
    expect(state.charges).toHaveLength(1);
    expect(pod("gpu").prepaidUntil).toEqual(new Date(NOW - 1000 + BLOCK_MS));
  });

  it("leaves the blocks due when the charge fails, and charges them on the next run", async () => {
    addCustomer("cus", -10_000);
    const paidUntil = new Date(NOW - 1000);
    addGpu("gpu", paidUntil);
    state.failNextCharge = true;
    await sync();
    expect(state.charges).toHaveLength(0);
    expect(pod("gpu").prepaidUntil).toEqual(paidUntil);
    await sync();
    expect(state.charges).toHaveLength(1);
  });

  it("pays up exactly what an earlier attempt charged when its reply was lost", async () => {
    // A block ago a run charged one block from this paid-up time, but never heard back, so the
    // paid-up time stayed put. Two blocks are due now; only the second is still unpaid.
    addCustomer("cus", -10_000);
    const paidUntil = new Date(NOW - BLOCK_MS - 1000);
    addGpu("gpu", paidUntil);
    const chargeId = `pod_instance-gpu_${paidUntil.getTime() / 1000}`;
    state.charges.push({ customerId: "cus", amount: 300, key: chargeId, description: "GPU usage", metadata: { pod_billing_id: chargeId, billing_minutes: "30" } });
    await sync();
    expect(state.charges).toHaveLength(1);
    expect(pod("gpu").prepaidUntil).toEqual(new Date(paidUntil.getTime() + BLOCK_MS));
    await sync();
    expect(state.charges.map(c => c.amount)).toEqual([300, 300]);
    expect(pod("gpu").prepaidUntil).toEqual(new Date(paidUntil.getTime() + 2 * BLOCK_MS));
  });

  it("does not leave paid time to refund on a GPU it skipped because it was stopped", async () => {
    addCustomer("cus", -10_000);
    addGpu("gpu", new Date(NOW - 1000));
    state.subs.get("team")![0].pods = [{ pod_status: "stopped" }];
    await sync();
    // Stopped GPUs are billed at the reservation rate with storage, not here.
    expect(state.charges.filter(c => c.description.startsWith("GPU usage"))).toHaveLength(0);
    expect(pod("gpu").prepaidAmountCents).toBe(0);
  });

  it("starts a GPU with no paid-up time at now, and charges its first block", async () => {
    addCustomer("cus", -10_000);
    addGpu("gpu", null);
    await sync();
    expect(state.charges).toEqual([expect.objectContaining({ amount: 300, key: `pod_instance-gpu_${NOW / 1000}` })]);
    expect(pod("gpu").prepaidUntil).toEqual(new Date(NOW + BLOCK_MS));
  });
});

describe("/api/sync negative balance", () => {
  it("keeps the GPU when a top-up ran but did not cover the whole debt", async () => {
    // The first run after deploy back-bills long-running GPUs; one top-up may not cover it.
    // Later top-ups keep paying it down, so this run must not shut the GPU down.
    addCustomer("cus", 12_000);
    addGpu("gpu", new Date(NOW - 1000));
    mocks.refill.mockImplementation(async (id: string) => {
      state.customers.get(id)!.balance -= 10_000;
      return { refilled: true, amount: 10_000 };
    });
    await sync();
    expect(state.customers.get("cus")!.balance).toBe(2300);
    expect(mocks.deleteInstance).not.toHaveBeenCalled();
  });

  it("keeps the GPU when the top-up hit a Stripe outage rather than a declined card", async () => {
    addCustomer("cus", 0);
    addGpu("gpu", new Date(NOW - 1000));
    mocks.refill.mockResolvedValue({ refilled: false, error: "Connection to Stripe failed" });
    await sync();
    expect(mocks.deleteInstance).not.toHaveBeenCalled();
  });

  it("does not charge the card of a customer with no GPUs and no debt", async () => {
    addCustomer("cus", -100);
    await sync();
    expect(mocks.refill).not.toHaveBeenCalled();
  });

  it("tops up from the saved card on every run, and keeps the GPU when that covers the debt", async () => {
    // Before, the top-up only ran when storage was due, about one run in five; the shutdown ran every time.
    addCustomer("cus", 0, { last_storage_sync_timestamp: String(NOW / 1000 - 60) });
    addGpu("gpu", new Date(NOW - 1000));
    mocks.refill.mockImplementation(async (id: string) => {
      state.customers.get(id)!.balance -= 2500;
      return { refilled: true, amount: 2500 };
    });
    await sync();
    expect(mocks.refill).toHaveBeenCalledWith("cus");
    expect(mocks.deleteInstance).not.toHaveBeenCalled();
  });

  it("waits while a top-up is already in progress", async () => {
    addCustomer("cus", 0);
    addGpu("gpu", new Date(NOW - 1000));
    mocks.refill.mockResolvedValue({ refilled: false, error: "Refill already in progress", pending: true });
    await sync();
    expect(state.customers.get("cus")!.balance).toBe(300);
    expect(mocks.deleteInstance).not.toHaveBeenCalled();
  });

  it("leaves a GPU running for a debt of up to $1", async () => {
    addCustomer("cus", -250);
    addGpu("gpu", new Date(NOW - 1000));
    mocks.refill.mockResolvedValue({ refilled: false, error: "No payment method on file", paymentFailed: true });
    await sync();
    expect(state.customers.get("cus")!.balance).toBe(50);
    expect(mocks.deleteInstance).not.toHaveBeenCalled();
  });

  it("stops only the hourly GPUs the customer pays for, and keeps the team's storage", async () => {
    addCustomer("cus", 0);
    addGpu("hourly", new Date(NOW - 1000));
    addGpu("monthly", new Date(NOW + 10 * BLOCK_MS), { billingType: "monthly" });
    addGpu("teammate", new Date(NOW + 10 * BLOCK_MS), { stripeCustomerId: "teammate" });
    addCustomer("teammate", -10_000);
    state.volumes.set("team", [{ id: 7, team_id: "team", size_in_gb: 100 }]);
    mocks.refill.mockResolvedValue({ refilled: false, error: "Your card was declined.", paymentFailed: true });
    await sync();
    expect(mocks.deleteInstance.mock.calls).toEqual([["hourly"]]);
    expect(mocks.deleteVolume).not.toHaveBeenCalled();
  });
});

describe("/api/sync storage metering", () => {
  it("meters at most a day of storage after a long gap", async () => {
    state.storagePrice = 1;
    addCustomer("cus", -10_000, { last_storage_sync_timestamp: String(NOW / 1000 - 10 * 86_400) });
    state.volumes.set("team", [{ id: 7, team_id: "team", size_in_gb: 100 }]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await sync();
    expect(state.charges.map(c => c.amount)).toEqual([2400]);
  });

  it("charges storage for the time since it was last metered", async () => {
    // Runs are 5 minutes apart, so metering lands every 25 minutes; each used to charge 30.
    state.storagePrice = 1; // 1 cent per GB-hour
    addCustomer("cus", -10_000);
    state.volumes.set("team", [{ id: 7, team_id: "team", size_in_gb: 120 }]);
    await sync();
    vi.setSystemTime(NOW + 25 * 60_000);
    await sync();
    expect(state.charges.map(c => c.amount)).toEqual([60, 50]);
    expect(state.charges.map(c => c.key)).toEqual(["storage_cus_first", `storage_cus_${NOW / 1000}`]);
    expect(state.customers.get("cus")!.metadata.last_storage_sync_timestamp).toBe(String(NOW / 1000 + 25 * 60));
  });
});

describe("/api/sync reconciliation", () => {
  it("is off unless BILLING_RECONCILIATION_ENABLED is set", async () => {
    // An active GPU on the team with no PodMetadata row: reconciliation would switch the
    // account to hourly and start billing it.
    addCustomer("cus", 0, { billing_type: "monthly" });
    state.poolCache = { pools: [{ id: 15, name: "B200", pods: [{ teamId: "team", status: "active" }] }] };
    vi.setSystemTime(NOW + 24 * 3_600_000); // past the hourly limit set by earlier runs
    state.subs.set("team", [{ id: "orphan", status: "active", pods: [{ pod_status: "running" }], per_pod_info: { vgpu_count: 1 } }]);
    await sync();
    expect(state.customers.get("cus")!.metadata.billing_type).toBe("monthly");
  });
});
