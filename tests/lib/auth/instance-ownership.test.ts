import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), services: vi.fn(), cache: new Map<string, unknown>() }));
vi.mock("@/lib/hostedai/client", () => ({ getCached: (key: string) => mocks.cache.get(key) ?? null, setCache: (key: string, value: unknown) => mocks.cache.set(key, value) }));
vi.mock("@/lib/hostedai/instances", () => ({ getUnifiedInstances: mocks.list }));
vi.mock("@/lib/hostedai/services", () => ({ getExposedServices: mocks.services }));

import { ownsInstance, rejectUnownedInstance, rejectUnownedService } from "@/lib/auth/instance-ownership";

const mine = "i-11111111-1111-1111-1111-111111111111";
const theirs = "i-22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cache.clear();
  mocks.list.mockImplementation(async (team: string) => ({ items: team === "team-a" ? [{ id: mine, team: { id: "team-a" } }] : [], total_items: team === "team-a" ? 1 : 0 }));
});

describe("instance ownership", () => {
  it("accepts an instance listed for one of the caller's teams, in either saved id form", async () => {
    expect(await ownsInstance(["team-b", "team-a"], mine)).toBe(true);
    expect(await ownsInstance(["team-a"], `instance-${mine}`)).toBe(true);
  });

  it("rejects another customer's instance, a missing id and a caller with no team", async () => {
    expect(await ownsInstance(["team-a"], theirs)).toBe(false);
    expect(await ownsInstance(["team-a"], "")).toBe(false);
    expect(await ownsInstance([], mine)).toBe(false);
    expect((await rejectUnownedInstance(["team-a"], theirs))?.status).toBe(404);
    expect(await rejectUnownedInstance(["team-a"], mine)).toBeNull();
  });

  it("does not trust a row hosted.ai returns for another team in this team's list", async () => {
    mocks.list.mockResolvedValue({ items: [{ id: theirs, team: { id: "team-z" } }], total_items: 1 });
    expect(await ownsInstance(["team-a"], theirs)).toBe(false);
  });

  it("does not trust a row with no team, since it cannot be shown to be this team's", async () => {
    mocks.list.mockResolvedValue({ items: [{ id: theirs }], total_items: 1 });
    expect(await ownsInstance(["team-a"], theirs)).toBe(false);
  });

  it("keeps paging when hosted.ai leaves out the total", async () => {
    const page = (n: number) => Array.from({ length: 100 }, (_, i) => ({ id: `i-page${n}-${i}`, team: { id: "team-a" } }));
    mocks.list.mockImplementation(async (_team: string, n: number) => ({ items: n < 1 ? page(n) : [{ id: mine, team: { id: "team-a" } }] }));
    expect(await ownsInstance(["team-a"], mine)).toBe(true);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("stops when hosted.ai hands back the same page again", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: `i-same-${i}`, team: { id: "team-a" } }));
    mocks.list.mockResolvedValue({ items: page });
    expect(await ownsInstance(["team-a"], theirs)).toBe(false);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("pages through a team with more than one page of instances", async () => {
    const page = (n: number) => Array.from({ length: 100 }, (_, i) => ({ id: `i-page${n}-${i}`, team: { id: "team-a" } }));
    mocks.list.mockImplementation(async (_team: string, n: number) => ({ items: n < 2 ? page(n) : [{ id: mine, team: { id: "team-a" } }], total_items: 201 }));
    expect(await ownsInstance(["team-a"], mine)).toBe(true);
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });

  it("remembers a confirmed owner but never a refusal", async () => {
    expect(await ownsInstance(["team-a"], mine)).toBe(true);
    expect(await ownsInstance(["team-a"], mine)).toBe(true);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(await ownsInstance(["team-a"], theirs)).toBe(false);
    expect(await ownsInstance(["team-a"], theirs)).toBe(false);
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });

  it("fails closed when hosted.ai cannot be asked", async () => {
    mocks.list.mockRejectedValue(new Error("fetch failed"));
    await expect(ownsInstance(["team-a"], mine)).rejects.toThrow("fetch failed");
  });

  it("accepts an exposed service only on an owned instance that lists it", async () => {
    mocks.services.mockResolvedValue([{ id: 5 }]);
    expect(await rejectUnownedService(["team-a"], mine, "5")).toBeNull();
    expect((await rejectUnownedService(["team-a"], mine, 6))?.status).toBe(404);
    expect((await rejectUnownedService(["team-a"], theirs, 5))?.status).toBe(404);
  });
});
