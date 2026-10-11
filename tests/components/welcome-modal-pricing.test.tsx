import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WelcomeModal } from "@/app/dashboard/components/modals/WelcomeModal";

afterEach(cleanup);

describe("welcome modal wallet amounts", () => {
  it("offers wallet credit without quoting a GPU price or GPU hours", async () => {
    const onTopup = vi.fn();
    await act(async () => {
      render(<WelcomeModal isOpen onClose={vi.fn()} token="t" topupLoading={false} onTopup={onTopup} />);
    });

    // GPU prices vary by product and configuration; the launcher shows the real price.
    expect(screen.queryAllByText(/\/hr|GPU time|\d+h\b/)).toHaveLength(0);
    expect(screen.getAllByText("Added to your wallet")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: /\$50/ }));
    expect(onTopup).toHaveBeenCalledWith(5000, undefined);
  });
});
