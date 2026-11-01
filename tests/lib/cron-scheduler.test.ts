import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Read once when the scheduler module loads.
vi.hoisted(() => {
  process.env.CRON_SECRET = "test-cron-secret";
});

// Last-run state lives in data/.cron-state.json; keep the tests off the disk.
vi.mock("fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("no state"); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Each test loads a fresh scheduler: job state (last run, running) is module-level.
const loadScheduler = async () => { vi.resetModules(); return import("@/lib/cron-scheduler"); };

// On prod nothing called /api/sync, so running GPUs were charged their first 30 minutes and
// never again. The scheduler now runs it, and must never run two billing passes at once.

const syncCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/api/sync"));

describe("cron scheduler billing", () => {
  let finishSync: (() => void) | undefined;
  let scheduler: Awaited<ReturnType<typeof loadScheduler>>;

  beforeEach(async () => {
    scheduler = await loadScheduler();
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/sync")) await new Promise<void>(resolve => { finishSync = resolve; });
      return Response.json({ success: true });
    }));
  });

  afterEach(() => {
    scheduler.stopCronScheduler();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("runs the billing sync with the cron secret soon after boot", async () => {
    scheduler.startCronScheduler();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(syncCalls()).toHaveLength(1);
    expect(syncCalls()[0][1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer test-cron-secret" } });
  });

  it("does not start a second billing run while the first is still going", async () => {
    scheduler.startCronScheduler();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(syncCalls()).toHaveLength(1);

    finishSync!();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);
    expect(syncCalls()).toHaveLength(2);
  });
});
