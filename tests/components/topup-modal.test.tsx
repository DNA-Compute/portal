import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TopupModal } from "@/app/dashboard/components/modals/TopupModal";

afterEach(cleanup);

describe("top-up modal custom amount", () => {
  it("offers $100, $250 and $1,000 presets plus a custom amount that pays only valid whole dollars", () => {
    const onTopup = vi.fn();
    render(<TopupModal isOpen onClose={vi.fn()} token="t" topupLoading={false} onTopup={onTopup} />);
    for (const label of ["$100", "$250", "$1,000"]) expect(screen.getByRole("button", { name: new RegExp(`^\\${label}`) })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^\$25 / })).toBeNull();

    const input = screen.getByLabelText("Custom amount");
    expect(screen.queryByRole("button", { name: /^Pay/ })).toBeNull();

    fireEvent.change(input, { target: { value: "10" } });
    expect(screen.getByRole("button", { name: "Pay" })).toBeDisabled();
    expect(screen.getByText(/\$25 to \$10,000, whole dollars/)).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "375" } });
    expect(screen.getByText("~187h GPU time")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pay $375" }));
    expect(onTopup).toHaveBeenCalledWith(37500, undefined);

    fireEvent.click(screen.getByRole("button", { name: /^\$1,000/ }));
    expect(onTopup).toHaveBeenLastCalledWith(100000, undefined);
  });
});
