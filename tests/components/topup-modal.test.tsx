import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TopupModal } from "@/app/dashboard/components/modals/TopupModal";

afterEach(cleanup);

describe("top-up modal custom amount", () => {
  it("replaces the largest preset with a custom amount that pays only valid whole dollars", () => {
    const onTopup = vi.fn();
    render(<TopupModal isOpen onClose={vi.fn()} token="t" topupLoading={false} onTopup={onTopup} />);
    expect(screen.queryByRole("button", { name: /\$250/ })).toBeNull();

    const input = screen.getByLabelText("Custom amount");
    const pay = screen.getByRole("button", { name: "Pay" });
    expect(pay).toBeDisabled();

    fireEvent.change(input, { target: { value: "10" } });
    expect(pay).toBeDisabled();
    expect(screen.getByText(/Whole dollars, \$25 to \$10,000/)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "375" } });
    expect(screen.getByText("~187h GPU time")).toBeInTheDocument();
    fireEvent.click(pay);
    expect(onTopup).toHaveBeenCalledWith(37500, undefined);

    fireEvent.click(screen.getByRole("button", { name: /\$50/ }));
    expect(onTopup).toHaveBeenLastCalledWith(5000, undefined);
  });
});
