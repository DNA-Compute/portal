/**
 * Every customer route that takes an instance (or exposed-service) id must refuse one that belongs to
 * another customer. hosted.ai acts on any id under the platform key, so a missing check lets anyone
 * who learns an id read its SSH password, terminate it, or take its prepaid credit.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const VICTIM = "i-99999999-9999-9999-9999-999999999999";
const ATTACKER_CUSTOMER = { id: "cus_attacker", email: "attacker@example.com", metadata: { hostedai_team_id: "team-attacker" } };

const m = vi.hoisted(() => {
  const fn = () => vi.fn();
  const models: Record<string, Record<string, ReturnType<typeof vi.fn>>> = {};
  const prisma = new Proxy({}, { get: (_, model: string) => {
    if (model === "then") return undefined;
    models[model] ??= new Proxy({}, { get: (target: Record<string, ReturnType<typeof vi.fn>>, method: string) => (target[method] ??= vi.fn(async () => null)) }) as never;
    return models[model];
  } });
  return {
    prisma, models,
    hostedai: {
      unsubscribeFromPool: fn(), getPoolSubscriptions: fn(), deleteInstance: fn(), getUnifiedInstanceDetail: fn(), getInstance: fn(),
      getConnectionInfo: fn(), getInstanceCredentials: fn(), getTeamInstances: fn(), exposeService: fn(), updateExposedService: fn(),
      deleteExposedService: fn(), getExposedServices: fn(), startVNCSession: fn(), stopVNCSession: fn(), scalePoolSubscription: fn(),
      stopInstance: fn(), startInstance: fn(), getSharedVolumes: fn(), getSharedStorageBlocks: fn(), createSharedVolume: fn(),
      podVolumeAction: fn(), getExposeServiceStatus: fn(), restartInstance: fn(),
    } as Record<string, ReturnType<typeof vi.fn>>,
    ownTeamList: vi.fn(), balance: vi.fn(), spawn: vi.fn(), ssh: vi.fn(), requirePermission: vi.fn(),
  };
});

vi.mock("@/lib/hostedai", async () => ({
  ...m.hostedai, getUnifiedInstances: m.ownTeamList,
  sshLoginFromCredentials: (await vi.importActual<typeof import("@/lib/hostedai/instances")>("@/lib/hostedai/instances")).sshLoginFromCredentials,
}));
vi.mock("@/lib/hostedai/client", () => ({ clearCache: vi.fn(), getCached: () => null, setCache: vi.fn() }));
vi.mock("@/lib/hostedai/instances", () => ({ getUnifiedInstances: m.ownTeamList }));
vi.mock("@/lib/hostedai/services", () => ({ getExposedServices: m.hostedai.getExposedServices }));
vi.mock("@/lib/prisma", () => ({ prisma: m.prisma }));
vi.mock("@/lib/stripe", () => ({ getStripe: async () => ({ customers: { createBalanceTransaction: m.balance, retrieve: async () => ATTACKER_CUSTOMER } }) }));
vi.mock("stripe", () => ({ default: class { customers = { createBalanceTransaction: m.balance, retrieve: async () => ATTACKER_CUSTOMER }; } }));
vi.mock("child_process", () => ({ spawn: m.spawn, default: { spawn: m.spawn } }));
vi.mock("@/lib/ssh-keys", () => ({ getOrCreateServerSSHKey: m.ssh, executeSSHWithKey: m.ssh, injectServerKeyIntoPod: m.ssh }));
vi.mock("@/lib/customer-auth", async importOriginal => ({ ...(await importOriginal<object>()),
  verifyCustomerToken: () => ({ email: "attacker@example.com", customerId: "cus_attacker", type: "customer-dashboard" }) }));
vi.mock("@/lib/auth", async importOriginal => ({ ...(await importOriginal<object>()),
  verifyCustomerToken: () => ({ email: "attacker@example.com", customerId: "cus_attacker", type: "customer-dashboard" }) }));
vi.mock("@/lib/auth/account-resolver", () => ({ resolveOperatingContext: async () => ({
  accountId: "cus_attacker", customer: { id: "cus_attacker", email: "attacker@example.com", metadata: { hostedai_team_id: "team-attacker" } },
  teamId: "team-attacker", allTeamIds: ["team-attacker"], allCustomerIds: ["cus_attacker"], isOwner: true }) }));
vi.mock("@/lib/auth/gate", () => ({ gatePermission: async () => null }));
vi.mock("@/lib/auth/audit", () => ({ requirePermission: m.requirePermission }));
vi.mock("@/lib/auth/helpers", () => ({ getAuthenticatedCustomer: async () => ({
  payload: { email: "attacker@example.com", customerId: "cus_attacker" }, customer: { id: "cus_attacker", email: "attacker@example.com" },
  teamId: "team-attacker", allTeamIds: ["team-attacker"], accountId: "cus_attacker" }) }));

const victimPod = { pod_name: "victim-pod", pod_status: "running", ssh_info: { cmd: "ssh ubuntu@10.0.0.9 -p 22", pass: "victim-pass" } };
const victimRow = {
  id: 1, instanceId: VICTIM, subscriptionId: `instance-${VICTIM}`, stripeCustomerId: "cus_victim", displayName: "victim box", notes: "private",
  prepaidUntil: new Date(Date.now() + 20 * 60_000), prepaidAmountCents: 180, hourlyRateCents: 360, hourlyRateBasis: "per_instance",
  rateSnapshot: { totalHourlyCents: 360 }, launchConfiguration: {}, billingType: "hourly", gpuCount: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // The attacker's own team has nothing; every id below belongs to someone else.
  m.ownTeamList.mockResolvedValue({ items: [], total_items: 0 });
  m.requirePermission.mockReturnValue(null);
  const h = m.hostedai;
  h.getPoolSubscriptions.mockResolvedValue([{ id: VICTIM, pool_id: 15, pods: [victimPod] }]);
  h.getConnectionInfo.mockResolvedValue([{ id: VICTIM, pool_name: "B200", pods: [victimPod] }]);
  h.getInstanceCredentials.mockResolvedValue({ ip: "10.0.0.9", port: 22, username: "ubuntu", password: "victim-pass" });
  h.getUnifiedInstanceDetail.mockResolvedValue({ id: VICTIM, status: "running", team: { id: "team-victim" }, region: { id: 9 }, shared_volumes: [{ id: 3, name: "data" }] });
  h.getInstance.mockResolvedValue({ id: VICTIM, name: "victim box" });
  h.getExposedServices.mockResolvedValue([{ id: 5, service_name: "api", ip: "10.0.0.9", internal_port: 8000, external_port: 31000 }]);
  for (const name of ["deleteInstance", "unsubscribeFromPool", "exposeService", "updateExposedService", "deleteExposedService", "startVNCSession",
    "stopVNCSession", "scalePoolSubscription", "stopInstance", "startInstance", "getExposeServiceStatus", "getTeamInstances", "restartInstance"]) h[name].mockResolvedValue({});
  m.models.podMetadata = undefined as never;
  (m.prisma as { podMetadata: Record<string, ReturnType<typeof vi.fn>> }).podMetadata.findFirst.mockResolvedValue(victimRow);
  (m.prisma as { podMetadata: Record<string, ReturnType<typeof vi.fn>> }).podMetadata.findUnique.mockResolvedValue(victimRow);
});

const req = (path: string, method = "GET", body?: unknown) => new NextRequest(`http://localhost${path}`, {
  method, headers: { Authorization: "Bearer attacker", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
});
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const pod = () => (m.prisma as { podMetadata: Record<string, ReturnType<typeof vi.fn>> }).podMetadata;

type Case = { name: string; call: () => Promise<Response>; untouched: () => ReturnType<typeof vi.fn>[] };
const cases: Case[] = [
  { name: "DELETE /api/instances/pool-subscription/[id] (dashboard Terminate)",
    call: async () => (await import("@/app/api/instances/pool-subscription/[id]/route")).DELETE(req(`/api/instances/pool-subscription/${VICTIM}`, "DELETE"), params(VICTIM)),
    untouched: () => [m.hostedai.deleteInstance, m.balance, pod().delete] },
  { name: "DELETE /api/instances/pool-subscription/[id] with the saved instance- form",
    call: async () => (await import("@/app/api/instances/pool-subscription/[id]/route")).DELETE(req(`/api/instances/pool-subscription/instance-${VICTIM}`, "DELETE"), params(`instance-${VICTIM}`)),
    untouched: () => [m.hostedai.unsubscribeFromPool, m.hostedai.deleteInstance, m.balance, pod().delete] },
  { name: "GET /api/instances/pool-subscription/[id]",
    call: async () => (await import("@/app/api/instances/pool-subscription/[id]/route")).GET(req(`/api/instances/pool-subscription/${VICTIM}`), params(VICTIM)),
    untouched: () => [] },
  { name: "PATCH /api/instances/pool-subscription/[id]",
    call: async () => (await import("@/app/api/instances/pool-subscription/[id]/route")).PATCH(req(`/api/instances/pool-subscription/${VICTIM}`, "PATCH", { displayName: "pwned", notes: "x" }), params(VICTIM)),
    untouched: () => [pod().update, pod().upsert, pod().updateMany] },
  { name: "GET /api/instances/[id]",
    call: async () => (await import("@/app/api/instances/[id]/route")).GET(req(`/api/instances/${VICTIM}`), params(VICTIM)),
    untouched: () => [m.hostedai.getInstance] },
  { name: "DELETE /api/instances/[id]",
    call: async () => (await import("@/app/api/instances/[id]/route")).DELETE(req(`/api/instances/${VICTIM}`, "DELETE"), params(VICTIM)),
    untouched: () => [m.hostedai.deleteInstance] },
  { name: "PUT /api/instances/[id]/stop",
    call: async () => (await import("@/app/api/instances/[id]/stop/route")).PUT(req(`/api/instances/${VICTIM}/stop`, "PUT"), params(VICTIM)),
    untouched: () => [m.hostedai.stopInstance] },
  { name: "PUT /api/instances/[id]/start",
    call: async () => (await import("@/app/api/instances/[id]/start/route")).PUT(req(`/api/instances/${VICTIM}/start`, "PUT"), params(VICTIM)),
    untouched: () => [m.hostedai.startInstance] },
  { name: "POST /api/instances/[id]/vnc",
    call: async () => (await import("@/app/api/instances/[id]/vnc/route")).POST(req(`/api/instances/${VICTIM}/vnc`, "POST"), params(VICTIM)),
    untouched: () => [m.hostedai.startVNCSession] },
  { name: "DELETE /api/instances/[id]/vnc",
    call: async () => (await import("@/app/api/instances/[id]/vnc/route")).DELETE(req(`/api/instances/${VICTIM}/vnc`, "DELETE"), params(VICTIM)),
    untouched: () => [m.hostedai.stopVNCSession] },
  { name: "GET /api/instances/[id]/gpu-metrics",
    call: async () => (await import("@/app/api/instances/[id]/gpu-metrics/route")).GET(req(`/api/instances/${VICTIM}/gpu-metrics`), params(VICTIM)),
    untouched: () => [m.hostedai.getExposedServices] },
  { name: "GET /api/instances/[id]/system-metrics",
    call: async () => (await import("@/app/api/instances/[id]/system-metrics/route")).GET(req(`/api/instances/${VICTIM}/system-metrics`), params(VICTIM)),
    untouched: () => [m.hostedai.getInstanceCredentials, m.spawn] },
  { name: "GET /api/instances/connection-info?instance_id",
    call: async () => (await import("@/app/api/instances/connection-info/route")).GET(req(`/api/instances/connection-info?instance_id=${VICTIM}`)),
    untouched: () => [m.hostedai.getInstanceCredentials] },
  { name: "GET /api/instances/connection-info?subscription_id",
    call: async () => (await import("@/app/api/instances/connection-info/route")).GET(req(`/api/instances/connection-info?subscription_id=${VICTIM}`)),
    untouched: () => [m.hostedai.getConnectionInfo] },
  { name: "POST /api/instances/pool-subscription/[id]/scale",
    call: async () => (await import("@/app/api/instances/pool-subscription/[id]/scale/route")).POST(req(`/api/instances/pool-subscription/${VICTIM}/scale`, "POST", { vgpus: 2, pool_id: 15 }), params(VICTIM)),
    untouched: () => [m.hostedai.scalePoolSubscription] },
  { name: "GET /api/instances/pool-subscription/[id]/add-storage",
    call: async () => (await import("@/app/api/instances/pool-subscription/[id]/add-storage/route")).GET(req(`/api/instances/pool-subscription/${VICTIM}/add-storage`), params(VICTIM)),
    untouched: () => [m.hostedai.getUnifiedInstanceDetail] },
  { name: "POST /api/instances/run-script",
    call: async () => (await import("@/app/api/instances/run-script/route")).POST(req("/api/instances/run-script", "POST", { script: "id", subscriptionId: VICTIM, podName: "victim-pod" })),
    untouched: () => [m.hostedai.getConnectionInfo, m.hostedai.getInstanceCredentials, m.spawn] },
  { name: "POST /api/apps/install",
    call: async () => (await import("@/app/api/apps/install/route")).POST(req("/api/apps/install", "POST", { subscriptionId: VICTIM, appSlug: "comfyui" })),
    untouched: () => [m.hostedai.getConnectionInfo, m.hostedai.getInstanceCredentials, m.spawn, m.ssh] },
  { name: "GET /api/services?instanceId",
    call: async () => (await import("@/app/api/services/route")).GET(req(`/api/services?instanceId=${VICTIM}`)),
    untouched: () => [m.hostedai.getExposedServices] },
  { name: "POST /api/services",
    call: async () => (await import("@/app/api/services/route")).POST(req("/api/services", "POST", { pod_name: "victim-pod", pool_subscription_id: VICTIM, port: 22, service_name: "ssh", protocol: "TCP", service_type: "NodePort" })),
    untouched: () => [m.hostedai.exposeService] },
  { name: "PUT /api/services",
    call: async () => (await import("@/app/api/services/route")).PUT(req("/api/services", "PUT", { id: 5, instanceId: VICTIM, service_name: "api", port: 22, protocol: "TCP", service_type: "NodePort" })),
    untouched: () => [m.hostedai.updateExposedService] },
  { name: "DELETE /api/services?id",
    call: async () => (await import("@/app/api/services/route")).DELETE(req(`/api/services?id=5&instanceId=${VICTIM}`, "DELETE")),
    untouched: () => [m.hostedai.deleteExposedService] },
  { name: "POST /api/instances/pool-subscription/[id]/stop (dashboard Stop)",
    call: async () => (await import("@/app/api/instances/pool-subscription/[id]/stop/route")).POST(req(`/api/instances/pool-subscription/${VICTIM}/stop`, "POST"), params(VICTIM)),
    untouched: () => [m.hostedai.stopInstance] },
  { name: "POST /api/instances/pool-subscription/[id]/start (dashboard Start)",
    call: async () => (await import("@/app/api/instances/pool-subscription/[id]/start/route")).POST(req(`/api/instances/pool-subscription/${VICTIM}/start`, "POST"), params(VICTIM)),
    untouched: () => [m.hostedai.startInstance, m.hostedai.getInstanceCredentials] },
  { name: "POST /api/instances/pool-subscription/[id]/restart (dashboard Restart)",
    call: async () => (await import("@/app/api/instances/pool-subscription/[id]/restart/route")).POST(req(`/api/instances/pool-subscription/${VICTIM}/restart`, "POST"), params(VICTIM)),
    untouched: () => [m.hostedai.restartInstance, m.hostedai.getInstanceCredentials] },
  { name: "GET /api/terminal (web terminal)",
    call: async () => (await import("@/app/api/terminal/route")).GET(req(`/api/terminal?subscription_id=${VICTIM}`)),
    untouched: () => [m.hostedai.getInstanceCredentials] },
  { name: "POST /api/instances/pool-subscription/[id]/snapshot",
    call: async () => (await import("@/app/api/instances/pool-subscription/[id]/snapshot/route")).POST(req(`/api/instances/pool-subscription/${VICTIM}/snapshot`, "POST", { displayName: "copy" }), params(VICTIM)),
    untouched: () => [m.hostedai.unsubscribeFromPool, m.hostedai.getConnectionInfo, m.spawn] },
  { name: "GET /api/instances/pool-subscription/[id]/snapshot/prepare",
    call: async () => (await import("@/app/api/instances/pool-subscription/[id]/snapshot/prepare/route")).GET(req(`/api/instances/pool-subscription/${VICTIM}/snapshot/prepare`), params(VICTIM)),
    untouched: () => [m.hostedai.getConnectionInfo, m.spawn] },
  { name: "POST /api/huggingface/deploy-existing",
    call: async () => (await import("@/app/api/huggingface/deploy-existing/route")).POST(req("/api/huggingface/deploy-existing", "POST", { hfItemId: "meta-llama/Llama-3.1-8B", subscriptionId: VICTIM })),
    untouched: () => [m.spawn, m.ssh, m.hostedai.getInstanceCredentials] },
  { name: "GET /api/services/status",
    call: async () => (await import("@/app/api/services/status/route")).GET(req(`/api/services/status?serviceName=api&poolSubscriptionId=${VICTIM}&operationId=op-1`)),
    untouched: () => [m.hostedai.getExposeServiceStatus] },
];

describe("customer routes refuse another customer's instance", () => {
  it.each(cases)("$name", async ({ call, untouched }) => {
    const response = await call();
    expect(response.status).toBe(404);
    const text = JSON.stringify(await response.json());
    expect(text).not.toMatch(/victim-pass|10\.0\.0\.9|victim box|private/);
    for (const spy of untouched()) expect(spy).not.toHaveBeenCalled();
  });
});

describe("customer routes refuse a row hosted.ai returns from another team in the caller's list", () => {
  beforeEach(() => { m.ownTeamList.mockResolvedValue({ items: [{ id: VICTIM, team: { id: "team-victim" } }], total_items: 1 }); });
  it.each(cases)("$name", async ({ call, untouched }) => {
    const response = await call();
    expect(response.status).toBe(404);
    for (const spy of untouched()) expect(spy).not.toHaveBeenCalled();
  });
});

describe("SSH work on a GPU the caller owns", () => {
  // As on staging: the old connection-info endpoint lists nothing for today's i- instances,
  // while the instance's own credentials call answers with the login.
  beforeEach(() => {
    m.ownTeamList.mockResolvedValue({ items: [{ id: VICTIM, team: { id: "team-attacker" } }], total_items: 1 });
    m.hostedai.getConnectionInfo.mockResolvedValue([]);
    m.hostedai.getInstanceCredentials.mockResolvedValue({ ip: "10.0.0.7", port: 30022, username: "ubuntu", password: "own-pass" });
    m.ssh.mockResolvedValue({ privateKeyPath: "/tmp/key", stdout: "LISTEN", code: 0 });
    const models = m.prisma as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
    models.gpuApp.findUnique.mockResolvedValue({ id: 1 });
    models.installedApp.findFirst.mockResolvedValue(null);
    models.installedApp.create.mockResolvedValue({ id: 2 });
    models.installedApp.findMany.mockResolvedValue([{ id: 2, status: "running", port: 8188, app: { slug: "comfyui", name: "ComfyUI" } }]);
  });

  it("runs a script over SSH with the instance's own login", async () => {
    await cases.find(c => c.name === "POST /api/instances/run-script")!.call();
    expect(m.hostedai.getInstanceCredentials).toHaveBeenCalledWith(VICTIM);
    expect(m.spawn).toHaveBeenCalledWith("sshpass", expect.arrayContaining(["ubuntu@10.0.0.7"]), expect.anything());
  });

  it("installs an app with the instance's own login", async () => {
    const response = await cases.find(c => c.name === "POST /api/apps/install")!.call();
    expect(response.status).toBe(200);
    expect(m.hostedai.getInstanceCredentials).toHaveBeenCalledWith(VICTIM);
  });

  it("sends hosted.ai the bare instance id when the saved instance- form is used", async () => {
    const stop = (await import("@/app/api/instances/pool-subscription/[id]/stop/route")).POST;
    await stop(req(`/api/instances/pool-subscription/instance-${VICTIM}/stop`, "POST"), params(`instance-${VICTIM}`));
    expect(m.hostedai.stopInstance).toHaveBeenCalledWith(VICTIM);
    const terminal = (await import("@/app/api/terminal/route")).GET;
    await terminal(req(`/api/terminal?subscription_id=instance-${VICTIM}`));
    expect(m.hostedai.getInstanceCredentials).toHaveBeenCalledWith(VICTIM);
  });

  it("explains a hosted.ai failure while fetching the login for an app install", async () => {
    m.hostedai.getInstanceCredentials.mockRejectedValue(new Error("fetch failed"));
    const response = await cases.find(c => c.name === "POST /api/apps/install")!.call();
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/GPU provider/i);
  });

  it("checks an installed app is still running on the instance's own address", async () => {
    const { GET } = await import("@/app/api/apps/status/route");
    await GET(req(`/api/apps/status?subscriptionId=${VICTIM}&verify=true`));
    expect(m.ssh).toHaveBeenCalledWith("10.0.0.7", 30022, "ubuntu", "/tmp/key", expect.anything(), expect.anything());
  });
});

describe("app status", () => {
  it("does not probe another customer's instance over SSH, even with an install row for it", async () => {
    (m.prisma as Record<string, Record<string, ReturnType<typeof vi.fn>>>).installedApp.findMany
      .mockResolvedValue([{ id: 2, status: "running", port: 8188, app: { slug: "comfyui", name: "ComfyUI" } }]);
    const { GET } = await import("@/app/api/apps/status/route");
    await GET(req(`/api/apps/status?subscriptionId=${VICTIM}&verify=true`));
    expect(m.hostedai.getInstanceCredentials).not.toHaveBeenCalled();
    expect(m.ssh).not.toHaveBeenCalled();
  });
});

describe("exposing a service", () => {
  it("targets the instance whose ownership was checked, never a second id from the caller", async () => {
    const OWN = "i-11111111-1111-1111-1111-111111111111";
    m.ownTeamList.mockResolvedValue({ items: [{ id: OWN, team: { id: "team-attacker" } }], total_items: 1 });
    const { POST } = await import("@/app/api/services/route");
    await POST(req("/api/services", "POST", { pod_name: VICTIM, pool_subscription_id: `instance-${OWN}`, port: 22, service_name: "ssh", protocol: "TCP", service_type: "NodePort" }));
    expect(m.hostedai.exposeService).toHaveBeenCalledTimes(1);
    expect(m.hostedai.exposeService.mock.calls[0][0]).toMatchObject({ pod_name: OWN });
  });
});

describe("the web terminal", () => {
  it("needs GPU access, like SSH connection info, since it returns the SSH password", async () => {
    m.ownTeamList.mockResolvedValue({ items: [{ id: VICTIM, team: { id: "team-attacker" } }], total_items: 1 });
    m.requirePermission.mockImplementation((_auth: unknown, permission: string) =>
      permission === "gpu.access" ? Response.json({ error: "Forbidden" }, { status: 403 }) : null);
    const response = await cases.find(c => c.name.startsWith("GET /api/terminal"))!.call();
    expect(response.status).toBe(403);
    expect(m.hostedai.getInstanceCredentials).not.toHaveBeenCalled();
  });
});

describe("the same routes still serve the caller's own instance", () => {
  beforeEach(() => { m.ownTeamList.mockResolvedValue({ items: [{ id: VICTIM, team: { id: "team-attacker" } }], total_items: 1 }); });
  const allowed: { name: string; call: () => Promise<Response>; reached: () => ReturnType<typeof vi.fn> }[] = [
    // Without saved billing metadata, so this checks reaching hosted.ai rather than settlement.
    { name: "Terminate", call: () => { pod().findFirst.mockResolvedValue(null); return cases[0].call(); }, reached: () => m.hostedai.deleteInstance },
    { name: "SSH connection info", call: cases.find(c => c.name.includes("instance_id"))!.call, reached: () => m.hostedai.getInstanceCredentials },
    { name: "Stop", call: cases.find(c => c.name.includes("/stop"))!.call, reached: () => m.hostedai.stopInstance },
    { name: "Dashboard Stop", call: cases.find(c => c.name.includes("(dashboard Stop)"))!.call, reached: () => m.hostedai.stopInstance },
    { name: "Dashboard Restart", call: cases.find(c => c.name.includes("(dashboard Restart)"))!.call, reached: () => m.hostedai.restartInstance },
    { name: "Edit an exposed service", call: cases.find(c => c.name === "PUT /api/services")!.call, reached: () => m.hostedai.updateExposedService },
    { name: "Remove an exposed service", call: cases.find(c => c.name === "DELETE /api/services?id")!.call, reached: () => m.hostedai.deleteExposedService },
  ];
  it.each(allowed)("$name", async ({ call, reached }) => {
    const response = await call();
    expect(response.status).not.toBe(404);
    expect(reached()).toHaveBeenCalled();
  });
});
