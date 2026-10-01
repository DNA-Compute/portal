import { beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "@/instrumentation";
import { hostedaiRequest } from "@/lib/hostedai/client";
import { clearDefaultPoliciesCache, getDefaultPolicies, initializeDefaultPolicies } from "@/lib/hostedai/default-policies";
import type { ResourcePolicy } from "@/lib/hostedai/policies";
import {
  addRegionToDefaultPolicy,
  getDefaultResourcePolicy,
  syncTeamsToDefaultPolicy,
} from "@/lib/hostedai/policies";

vi.mock("@/lib/hostedai/client", () => ({ hostedaiRequest: vi.fn() }));
vi.mock("@/lib/cron-scheduler", () => ({ startCronScheduler: vi.fn() }));
vi.mock("@/lib/settings", () => ({ warmSettingsCache: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/hostedai", () => ({
  initializeDefaultPolicies: () => initializeDefaultPolicies(),
  initializeRoles: vi.fn().mockResolvedValue(undefined),
}));

const request = vi.mocked(hostedaiRequest);
const defaults = (resource: string) => [
  { type: "pricing", id: "pricing-live" },
  { type: "resource", id: resource },
  { type: "service", id: "service-live" },
  { type: "instance-type", id: "instance-live" },
  { type: "image", id: "image-live" },
];
const policy: ResourcePolicy = {
  id: "resource-old",
  name: "Customer regions",
  is_system_defined: false,
  is_default: true,
  globals: [],
  regions: [],
  teams: [{ id: "team-existing", name: "Existing team" }],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("Default resource policy operations", () => {
  beforeEach(() => {
    request.mockReset();
    clearDefaultPoliciesCache();
  });

  it.each([
    ["read", () => getDefaultResourcePolicy()],
    ["add region", () => addRegionToDefaultPolicy(7, ["team-new"])],
    ["sync teams", () => syncTeamsToDefaultPolicy(["team-new"])],
  ] as const)("prevents resource access for %s when defaults are unavailable", async (_name, operation) => {
    const failure = new Error("Hosted.ai defaults unavailable");
    request.mockImplementation(async (_method, path) => {
      if (path.startsWith("/policy/defaults")) throw failure;
      return policy;
    });

    await expect(operation()).rejects.toBe(failure);
    expect(request.mock.calls).toEqual([["GET", "/policy/defaults?nature=general"]]);
  });

  it("keeps mutations closed after a caught startup warm-up failure until defaults recover", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("TENANT_ENCRYPTION_KEY", "0".repeat(64));
    const failure = new Error("Hosted.ai defaults unavailable");
    let upstreamAvailable = false;
    request.mockImplementation(async (_method, path) => {
      if (path.startsWith("/policy/defaults")) {
        if (!upstreamAvailable) throw failure;
        return defaults(policy.id);
      }
      return policy;
    });

    try {
      await register();
      await expect(syncTeamsToDefaultPolicy(["team-new"])).rejects.toBe(failure);
      expect(request.mock.calls.filter(([method]) => method !== "GET")).toEqual([]);

      upstreamAvailable = true;
      await syncTeamsToDefaultPolicy(["team-new"]);
      expect(request.mock.calls.filter(([method]) => method === "PUT")).toEqual([
        ["PUT", `/resource-policy/${policy.id}`, {
          name: policy.name,
          regions: [],
          teams: ["team-existing", "team-new"],
        }],
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["add region", () => addRegionToDefaultPolicy(7, ["team-new"]), [{ region_id: 7, access: "unlimited" }]],
    ["sync teams", () => syncTeamsToDefaultPolicy(["team-existing", "team-new"]), []],
  ] as const)("pins the resolved policy ID throughout %s despite cache invalidation", async (_name, operation, regions) => {
    let finishRead!: (value: ResourcePolicy) => void;
    let startedRead!: () => void;
    const reading = new Promise<void>((resolve) => { startedRead = resolve; });
    const resourceRead = new Promise<ResourcePolicy>((resolve) => { finishRead = resolve; });
    request.mockImplementation(async (method, path) => {
      if (path.startsWith("/policy/defaults")) return defaults("resource-old");
      if (method === "GET") {
        startedRead();
        return resourceRead;
      }
    });

    const mutation = operation();
    await reading;
    clearDefaultPoliciesCache();
    request.mockResolvedValueOnce(defaults("resource-new"));
    await getDefaultPolicies();
    finishRead(policy);
    await mutation;

    expect(request).toHaveBeenCalledWith("GET", "/resource-policy/resource-old");
    expect(request).toHaveBeenCalledWith("PUT", "/resource-policy/resource-old", {
      name: policy.name,
      regions,
      teams: ["team-existing", "team-new"],
    });
    expect(request.mock.calls.filter(([method]) => method === "PUT")).toHaveLength(1);
  });
});
