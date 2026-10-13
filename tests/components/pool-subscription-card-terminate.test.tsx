import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PoolSubscriptionCard } from "@/app/dashboard/components/PoolSubscriptionCard";
import type { PoolSubscription } from "@/app/dashboard/components/types";

// On prod, hosted.ai reported running GPUs as "Pending" a couple of minutes after launch. The
// card showed the raw lowercase "pending" with no action bar, so Terminate could only be found
// by expanding the card and customers thought they could not stop paying. Terminate now sits on
// the card's action bar in every state.

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const card = (status: string, podStatus = status) => ({
  id: "i-1", status, pool_name: "B200", hourlyRate: 3.6, hourlyRateBasis: "per_instance",
  created_at: new Date().toISOString(), pods: [{ pod_name: "pod-1", pod_status: podStatus }],
}) as unknown as PoolSubscription;

const deletes = () => vi.mocked(fetch).mock.calls
  .filter(([, init]) => init?.method === "DELETE")
  .map(([input]) => String(input));

async function renderCard(subscription: PoolSubscription) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({})));
  await act(async () => {
    render(<PoolSubscriptionCard subscription={subscription} token="session" onRefresh={vi.fn()} metadata={{ displayName: "box", notes: null }} />);
  });
}

describe("GPU card Terminate", () => {
  it("says Warming up, not the raw status, while hosted.ai reports the GPU as pending", async () => {
    await renderCard(card("pending"));
    expect(screen.queryByText("pending")).toBeNull();
    expect(screen.getByText("Warming up...")).toBeInTheDocument();
  });

  it.each([
    ["pending", "pending"],
    ["running", "running"],
    ["running", "stopped"],
    ["running", "failed"],
  ])("offers Terminate without expanding the card (status %s, pod %s)", async (status, podStatus) => {
    await renderCard(card(status, podStatus));
    expect(screen.queryByText("Less")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Terminate" }));
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Terminate" }).at(-1)!);
    });
    expect(deletes()).toEqual(["/api/instances/pool-subscription/i-1"]);
  });
});
