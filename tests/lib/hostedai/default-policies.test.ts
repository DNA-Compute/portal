import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDefaultPoliciesCache,
  getDefaultPolicies,
} from "@/lib/hostedai/default-policies";
import { hostedaiRequest } from "@/lib/hostedai/client";

vi.mock("@/lib/hostedai/client", () => ({ hostedaiRequest: vi.fn() }));

const request = vi.mocked(hostedaiRequest);
const DAY = 24 * 60 * 60 * 1000;
const policies = {
  pricing: "price-345",
  resource: "res-012",
  service: "svc-456",
  instanceType: "inst-123",
  image: "img-789",
};

interface PolicyDefault {
  type: string;
  id: string;
  name: string;
}

function response(resource = policies.resource): PolicyDefault[] {
  return [
    { type: "instance-type", id: policies.instanceType, name: "Instance Type" },
    { type: "service", id: policies.service, name: "Service" },
    { type: "image", id: policies.image, name: "Image" },
    { type: "resource", id: resource, name: "Resource" },
    { type: "pricing", id: policies.pricing, name: "Pricing" },
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("Default Policies", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    request.mockReset();
    clearDefaultPoliciesCache();
  });

  afterEach(() => {
    clearDefaultPoliciesCache();
    vi.useRealTimers();
  });

  it("waits for a shared cold lookup before resolving any caller", async () => {
    const lookup = deferred<PolicyDefault[]>();
    request.mockReturnValueOnce(lookup.promise);
    const settled = vi.fn();
    const first = getDefaultPolicies().then(settled);
    const second = getDefaultPolicies().then(settled);

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("GET", "/policy/defaults?nature=general");

    lookup.resolve(response());
    await Promise.all([first, second]);
    expect(settled.mock.calls).toEqual([[policies], [policies]]);
  });

  it("rejects every cold caller on failure and permits a successful retry", async () => {
    const lookup = deferred<PolicyDefault[]>();
    const failure = new Error("Hosted.ai unavailable");
    request.mockReturnValueOnce(lookup.promise).mockResolvedValueOnce(response());
    const results = Promise.allSettled([getDefaultPolicies(), getDefaultPolicies()]);

    lookup.reject(failure);
    expect(await results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    await expect(getDefaultPolicies()).resolves.toEqual(policies);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["non-array response", null],
    ["missing required type", response().filter((policy) => policy.type !== "resource")],
    ["non-string required ID", response().map((policy) =>
      policy.type === "resource" ? { ...policy, id: 42 } : policy)],
    ["blank required ID", response().map((policy) =>
      policy.type === "resource" ? { ...policy, id: "   " } : policy)],
  ])("rejects %s without caching it", async (_label, invalidResponse) => {
    request.mockResolvedValueOnce(invalidResponse).mockResolvedValueOnce(response());

    await expect(getDefaultPolicies()).rejects.toBeInstanceOf(Error);
    await expect(getDefaultPolicies()).resolves.toEqual(policies);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("ignores unknown optional policy types even when their IDs are invalid", async () => {
    request.mockResolvedValueOnce([
      ...response(),
      { type: "storage", id: null },
      { type: "__proto__", id: "not-a-policy" },
    ]);

    await expect(getDefaultPolicies()).resolves.toEqual(policies);
  });

  it("caches a successful lookup for 24 hours, then refreshes", async () => {
    request.mockResolvedValueOnce(response()).mockResolvedValueOnce(response("res-new"));
    await expect(getDefaultPolicies()).resolves.toEqual(policies);

    vi.setSystemTime(Date.now() + DAY - 1);
    await expect(getDefaultPolicies()).resolves.toEqual(policies);
    expect(request).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 1);
    await expect(getDefaultPolicies()).resolves.toEqual({ ...policies, resource: "res-new" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retains only the last verified set after a failed refresh and retries without renewing its TTL", async () => {
    request.mockResolvedValueOnce(response());
    await getDefaultPolicies();
    vi.setSystemTime(Date.now() + DAY);
    request.mockRejectedValueOnce(new Error("Hosted.ai unavailable"));
    await expect(getDefaultPolicies()).resolves.toEqual(policies);

    request.mockResolvedValueOnce(response().filter((policy) => policy.type !== "image"));
    await expect(getDefaultPolicies()).resolves.toEqual(policies);

    request.mockResolvedValueOnce(response("res-new"));
    await expect(getDefaultPolicies()).resolves.toEqual({ ...policies, resource: "res-new" });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("does not retain verified values after explicit invalidation", async () => {
    request.mockResolvedValueOnce(response());
    await getDefaultPolicies();
    clearDefaultPoliciesCache();
    const failure = new Error("Hosted.ai unavailable");
    request.mockRejectedValueOnce(failure);

    await expect(getDefaultPolicies()).rejects.toBe(failure);
  });

  it("does not let an invalidated completion populate the cache or release a newer lookup", async () => {
    const oldLookup = deferred<PolicyDefault[]>();
    const newLookup = deferred<PolicyDefault[]>();
    request.mockReturnValueOnce(oldLookup.promise).mockReturnValueOnce(newLookup.promise);
    const oldCaller = getDefaultPolicies();
    clearDefaultPoliciesCache();
    const newCaller = getDefaultPolicies();

    oldLookup.resolve(response("res-old"));
    await oldCaller;
    const settled = vi.fn();
    const concurrentCaller = getDefaultPolicies().then(settled);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);

    newLookup.resolve(response("res-new"));
    await expect(newCaller).resolves.toEqual({ ...policies, resource: "res-new" });
    await concurrentCaller;
    expect(settled).toHaveBeenCalledWith({ ...policies, resource: "res-new" });
  });

  it("does not overwrite newer cached defaults when an invalidated lookup finishes last", async () => {
    const oldLookup = deferred<PolicyDefault[]>();
    request.mockReturnValueOnce(oldLookup.promise).mockResolvedValueOnce(response("res-new"));
    const oldCaller = getDefaultPolicies();
    clearDefaultPoliciesCache();
    await expect(getDefaultPolicies()).resolves.toEqual({ ...policies, resource: "res-new" });

    oldLookup.resolve(response("res-old"));
    await oldCaller;
    await expect(getDefaultPolicies()).resolves.toEqual({ ...policies, resource: "res-new" });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
