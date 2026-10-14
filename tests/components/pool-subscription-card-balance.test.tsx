import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PoolSubscriptionCard } from "@/app/dashboard/components/PoolSubscriptionCard";
import type { PoolSubscription } from "@/app/dashboard/components/types";

// On prod, terminating a GPU credited the unused time back to the wallet, but the dashboard
// and billing page kept showing the balance from before the credit until a page reload. The
// card now tells the dashboard once the termination has settled, so it reloads the balance.

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const subscription = {
  id: "i-1", status: "running", pool_name: "B200", hourlyRate: 3.6, hourlyRateBasis: "per_instance",
  created_at: new Date().toISOString(), pods: [{ pod_name: "pod-1", pod_status: "running" }],
} as unknown as PoolSubscription;

async function terminate(deleteStatus: number) {
  vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) =>
    init?.method === "DELETE" && deleteStatus !== 200
      ? Response.json({ error: "Instance not found" }, { status: deleteStatus })
      : Response.json({ success: true })));
  const onBalanceChange = vi.fn();
  await act(async () => {
    render(<PoolSubscriptionCard subscription={subscription} token="session" onRefresh={vi.fn()} onBalanceChange={onBalanceChange} metadata={{ displayName: "box", notes: null }} />);
  });
  fireEvent.click(screen.getByRole("button", { name: "Terminate" }));
  await act(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Terminate" }).at(-1)!);
  });
  return onBalanceChange;
}

describe("GPU card wallet balance", () => {
  it("asks the dashboard to reload the balance once a termination succeeds", async () => {
    expect(await terminate(200)).toHaveBeenCalledTimes(1);
  });

  it("leaves the balance alone when the termination fails", async () => {
    expect(await terminate(404)).not.toHaveBeenCalled();
  });
});
