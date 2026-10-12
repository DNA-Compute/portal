import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PoolSubscriptionCard } from "@/app/dashboard/components/PoolSubscriptionCard";
import type { PoolSubscription } from "@/app/dashboard/components/types";

// Pause, Restart and Terminate asked with window.confirm and reported failures with
// window.alert. Both block the page and do not match the portal, so the card asks and
// reports in the page instead.

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const subscription = {
  id: "i-1", status: "running", pool_name: "B200", hourlyRate: 3.6, hourlyRateBasis: "per_instance",
  created_at: new Date().toISOString(), pods: [{ pod_name: "pod-1", pod_status: "running" }],
} as unknown as PoolSubscription;

const posts = () => vi.mocked(fetch).mock.calls
  .filter(([, init]) => init?.method === "POST" || init?.method === "DELETE")
  .map(([input, init]) => `${init?.method} ${String(input)}`);

async function renderCard(stopStatus = 200) {
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith("/stop") && init?.method === "POST") {
      return stopStatus === 200 ? Response.json({ success: true }) : Response.json({ error: "Instance not found" }, { status: stopStatus });
    }
    return Response.json({});
  }));
  const confirmSpy = vi.spyOn(window, "confirm");
  const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
  await act(async () => {
    render(<PoolSubscriptionCard subscription={subscription} token="session" onRefresh={vi.fn()} metadata={{ displayName: "box", notes: null }} />);
  });
  return { confirmSpy, alertSpy };
}

describe("GPU card actions", () => {
  it("asks in the page before pausing, and does nothing on Cancel", async () => {
    const { confirmSpy } = await renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Stop this GPU?");
    expect(dialog).toHaveTextContent("You can start it again anytime.");
    expect(confirmSpy).not.toHaveBeenCalled();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Cancel" })); });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(posts()).toEqual([]);
  });

  it("pauses once the dialog is confirmed", async () => {
    await renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop GPU" })); });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(posts()).toEqual(["POST /api/instances/pool-subscription/i-1/stop"]);
  });

  it("shows a failed pause on the card instead of an alert", async () => {
    const { alertSpy } = await renderCard(404);
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Stop GPU" })); });

    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Instance not found");
  });

  it("closes the dialog on Escape without acting", async () => {
    await renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await act(async () => { fireEvent.keyDown(window, { key: "Escape" }); });

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(posts()).toEqual([]);
  });
});
