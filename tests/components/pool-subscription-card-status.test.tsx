import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PoolSubscriptionCard } from "@/app/dashboard/components/PoolSubscriptionCard";
import type { PoolSubscription } from "@/app/dashboard/components/types";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const subscription = {
  id: "i-1", status: "running", pool_name: "B200", hourlyRate: 3.6, hourlyRateBasis: "per_instance",
  created_at: new Date().toISOString(), pods: [{ pod_name: "pod-1", pod_status: "running" }],
} as unknown as PoolSubscription;

describe("GPU card status", () => {
  it("does not claim setup failed while it is still fetching whether the GPU is reachable", async () => {
    vi.useFakeTimers();
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

    vi.mocked(fetch).mockImplementation(async () => Response.json({ connectionInfo: [{ id: 1, pool_name: "B200", pods: [{ pod_name: "pod-1", pod_status: "running" }] }] }));
    await act(async () => {
      answer(Response.json({ connectionInfo: [{ id: 1, pool_name: "B200", pods: [{ pod_name: "pod-1", pod_status: "running" }] }] }));
      await vi.advanceTimersByTimeAsync(15 * 60_000);
    });
    // Once the lookups are done and there is still no SSH access, the failed setup is real.
    expect(screen.getByText("Setup failed")).toBeInTheDocument();
  });

  const lookups = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith("/api/instances/connection-info")).length;
  const renderCard = () => render(<PoolSubscriptionCard subscription={subscription} token="session" onRefresh={vi.fn()}
    metadata={{ displayName: "box", notes: null, startupScriptStatus: "failed" }} />);

  it("retries a failed SSH lookup, then stops saying Connecting and offers a retry", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async (input: string) =>
      input.startsWith("/api/instances/connection-info") ? Response.json({ error: "Failed" }, { status: 500 }) : Response.json({})));

    await act(async () => { renderCard(); });
    expect(screen.getByText("Connecting...")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60_000); });

    expect(lookups()).toBeGreaterThan(1);
    expect(screen.queryByText("Connecting...")).toBeNull();
    expect(screen.getByText("Setup failed")).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getAllByText("More")[0]); });
    const before = lookups();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry" })); });
    expect(screen.getByText(/Couldn.t load SSH details|Loading connection info/)).toBeInTheDocument();
    expect(lookups()).toBe(before + 1);
  });

  it("shows SSH once a lookup that failed at first succeeds on retry", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (!input.startsWith("/api/instances/connection-info")) return Response.json({});
      return ++calls === 1 ? Response.json({ error: "Failed" }, { status: 500 })
        : Response.json({ connectionInfo: [{ id: 0, pool_name: "B200", pods: [{ pod_name: "i-1", pod_status: "running", ssh_info: { cmd: "ssh -p 22 ubuntu@10.0.0.7", pass: "x" } }] }] });
    }));

    await act(async () => { renderCard(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(screen.queryByText("Connecting...")).toBeNull();
    expect(screen.queryByText("Setup failed")).toBeNull();
    expect(screen.getByRole("button", { name: "Terminal" })).toBeEnabled();
  });

  const sshEntry = { id: 0, pool_name: "B200", pods: [{ pod_name: "i-1", pod_status: "running", ssh_info: { cmd: "ssh -p 22 ubuntu@10.0.0.7", pass: "x" } }] };
  const noSshEntry = { id: 0, pool_name: "B200", pods: [{ pod_name: "i-1", pod_status: "running" }] };

  it("keeps asking while hosted.ai has not issued the SSH login yet, then enables the terminal", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (!input.startsWith("/api/instances/connection-info")) return Response.json({});
      return Response.json({ connectionInfo: [++calls < 3 ? noSshEntry : sshEntry] });
    }));
    await act(async () => { render(<PoolSubscriptionCard subscription={subscription} token="session" onRefresh={vi.fn()} metadata={{ displayName: "box", notes: null }} />); });
    expect(screen.getByText("Connecting...")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(calls).toBe(3);
    expect(screen.queryByText("Connecting...")).toBeNull();
    expect(screen.getByRole("button", { name: "Terminal" })).toBeEnabled();
  });

  it("says SSH is unavailable, not Running, when the login never arrives", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (input: string) =>
      input.startsWith("/api/instances/connection-info") ? Response.json({ connectionInfo: [noSshEntry] }) : Response.json({})));
    await act(async () => { render(<PoolSubscriptionCard subscription={subscription} token="session" onRefresh={vi.fn()} metadata={{ displayName: "box", notes: null }} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15 * 60_000); });

    expect(screen.queryByText("Connecting...")).toBeNull();
    expect(screen.getByText("SSH unavailable")).toBeInTheDocument();
    // A running GPU with a problem: a steady amber dot, not the grey of an unknown or off state.
    const dot = screen.getByText("SSH unavailable").previousElementSibling?.firstElementChild;
    expect(dot?.className).toContain("bg-amber-500");
    expect(dot?.className).not.toContain("animate-pulse");
  });

  it("shows Setting up, not Connecting, while the startup script runs", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) =>
      input.startsWith("/api/instances/connection-info") ? new Promise<Response>(() => {}) : Response.json({})));
    await act(async () => { render(<PoolSubscriptionCard subscription={subscription} token="session" onRefresh={vi.fn()} metadata={{ displayName: "box", notes: null, startupScriptStatus: "running" }} />); });
    expect(screen.getByText("Setting up...")).toBeInTheDocument();
  });
});
