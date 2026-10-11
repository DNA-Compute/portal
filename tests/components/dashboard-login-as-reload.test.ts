import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => nav.params }));

import { useDashboardData } from "@/app/dashboard/components/hooks/useDashboardData";

const account = {
  customer: { id: "cus_1", email: "customer@example.com", name: "Customer" }, userEmail: "customer@example.com",
  isOwner: true, skipTwoFactor: true, impersonator: { adminEmail: "admin@example.com" },
};

let verifyStatus = 200;
const requests = () => vi.mocked(fetch).mock.calls.map(([input, init]) => ({ path: String(input), body: init?.body ? String(init.body) : "" }));

beforeEach(() => {
  verifyStatus = 200;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    if (input === "/api/account/verify") return verifyStatus === 200 ? Response.json(account) : Response.json({ error: "Invalid or expired token" }, { status: verifyStatus });
    if (input === "/api/account/session") return Response.json({ token: "admin-own-session" });
    return Response.json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); window.history.replaceState({}, "", "/"); });

describe("admin Login As tab", () => {
  it("stays on the customer's account after a reload instead of falling back to the admin's own session", async () => {
    nav.params = new URLSearchParams("token=login-as-token");
    const first = renderHook(() => useDashboardData());
    await waitFor(() => expect(first.result.current.data).not.toBeNull());
    first.unmount();

    // A reload: the one-time token was stripped from the URL.
    nav.params = new URLSearchParams();
    vi.mocked(fetch).mockClear();
    const reloaded = renderHook(() => useDashboardData());
    await waitFor(() => expect(reloaded.result.current.data).not.toBeNull());

    expect(reloaded.result.current.data?.customer.email).toBe("customer@example.com");
    expect(requests().find(r => r.path === "/api/account/verify")?.body).toContain("login-as-token");
    expect(requests().some(r => r.path === "/api/account/session")).toBe(false);
  });

  it("says the Login As session ended once its token expires, rather than silently opening the admin's own account", async () => {
    nav.params = new URLSearchParams("token=login-as-token");
    const first = renderHook(() => useDashboardData());
    await waitFor(() => expect(first.result.current.data).not.toBeNull());
    first.unmount();

    nav.params = new URLSearchParams();
    verifyStatus = 401;
    vi.mocked(fetch).mockClear();
    const reloaded = renderHook(() => useDashboardData());
    await waitFor(() => expect(reloaded.result.current.error).toMatch(/Login as session has ended/i));

    expect(reloaded.result.current.data).toBeNull();
    expect(requests().some(r => r.path === "/api/account/session")).toBe(false);
  });
});
