import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { PoolSubscriptionCard } from "@/app/dashboard/components/PoolSubscriptionCard";
import type { PoolSubscription } from "@/app/dashboard/components/types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const subscription = {
  id: "i-1", status: "running", pool_name: "B200", hourlyRate: 3.6, hourlyRateBasis: "per_instance",
  created_at: new Date().toISOString(), pods: [{ pod_name: "pod-1", pod_status: "running" }],
} as unknown as PoolSubscription;

describe("GPU card status", () => {
  it("does not claim setup failed while it is still fetching whether the GPU is reachable", async () => {
    let answer!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input.startsWith("/api/instances/connection-info")) return new Promise<Response>(resolve => { answer = resolve; });
      return Response.json({});
    }));

    await act(async () => {
      render(<PoolSubscriptionCard subscription={subscription} token="session" onRefresh={vi.fn()}
        metadata={{ displayName: "box", notes: null, startupScriptStatus: "failed" }} />);
    });
    expect(screen.queryByText("Setup failed")).toBeNull();
    expect(screen.getByText("Connecting...")).toBeInTheDocument();

    await act(async () => {
      answer(Response.json({ connectionInfo: [{ id: 1, pool_name: "B200", pods: [{ pod_name: "pod-1", pod_status: "running" }] }] }));
    });
    // Once the answer is in and there is no SSH access, the failed setup is real.
    expect(screen.getByText("Setup failed")).toBeInTheDocument();
  });
});
