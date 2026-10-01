import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LaunchSoftwarePicker } from "@/app/dashboard/components/LaunchSoftwarePicker";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("model launch choices", () => {
  it("prevents unsupported selection but retains gated choices for authenticated validation", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ items: [
        { id: "org/quantized", name: "Quantized checkpoint", vramGb: 2,
          ...(url.includes("launch=true") ? { launchSupport: { status: "unsupported", message: "Pre-quantized models require a different runtime." } } : {}) },
        { id: "org/gated", name: "Gated checkpoint", gated: true, vramGb: 2,
          launchSupport: { status: "unverified", message: "Runtime compatibility is unverified until model access is checked." } },
        { id: "org/original", name: "Original checkpoint", vramGb: 161,
          launchSupport: { status: "supported", message: "Float16 runtime supported." } },
      ] }),
    })));
    const onChange = vi.fn();
    render(<LaunchSoftwarePicker token="session" value={{ kind: "huggingface", hfItemId: "" }} selected={null} onSelect={vi.fn()} onChange={onChange} />);
    const unsupported = await screen.findByRole("button", { name: /Quantized checkpoint/i });
    expect(unsupported).toBeDisabled();
    fireEvent.click(unsupported);
    expect(onChange).not.toHaveBeenCalled();
    const gated = screen.getByRole("button", { name: /Gated checkpoint/i });
    expect(gated).toBeEnabled();
    expect(gated).toHaveTextContent(/unverified/i);
    expect(gated).not.toHaveTextContent(/Estimated.*2 GB/i);
    fireEvent.click(gated);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ kind: "huggingface", hfItemId: "org/gated" }));
    expect(screen.getByRole("button", { name: /Original checkpoint/i })).toHaveTextContent(/161 GB/);
  });

  it("does not present search memory hints as verified float16 requirements", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.includes("/search?") ? { results: [{ id: "org/search", name: "Search checkpoint", vramGb: 1 }] } : { items: [] },
    })));
    render(<LaunchSoftwarePicker token="session" value={{ kind: "huggingface", hfItemId: "" }} selected={null} onSelect={vi.fn()} onChange={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "checkpoint" } });
    const result = await screen.findByRole("button", { name: /Search checkpoint/i });
    expect(result).toHaveTextContent(/unverified/i);
    expect(result).not.toHaveTextContent(/1 GB/);
  });
});
