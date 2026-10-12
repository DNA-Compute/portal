// @vitest-environment jsdom
//
// With no apps enabled, the Apps tab said "No apps found in this category" while
// "All Apps" was the only choice, which reads as if a filter was hiding them.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/app/dashboard/components/LaunchConfigurator", () => ({ LaunchConfigurator: () => null }));

import { AppsTab } from "@/app/dashboard/components/AppsTab";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Apps tab with no apps enabled", () => {
  it("says no apps are available, not that a category is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ apps: [] })));
    render(<AppsTab token="session" subscriptions={[]} onRefresh={vi.fn()} />);

    expect(await screen.findByText("No apps are available yet.")).toBeInTheDocument();
    expect(screen.queryByText(/in this category/i)).toBeNull();
  });
});
