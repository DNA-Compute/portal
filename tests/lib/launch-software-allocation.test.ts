import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HuggingFaceDeployment } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({ prisma: {
  podMetadata: { findFirst: vi.fn() },
  huggingFaceDeployment: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
} }));
vi.mock("@/lib/launch-capabilities", () => ({ assertServiceSupportsLaunch: vi.fn() }));
vi.mock("@/lib/huggingface-status", () => ({ getSSHCredentials: vi.fn(), executeRemoteScript: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { executeRemoteScript } from "@/lib/huggingface-status";
import { startPendingHuggingFaceDeployment } from "@/lib/launch-software";
import { encrypt } from "@/lib/crypto";

const credentials = { host: "192.0.2.1", port: 22, username: "user", password: "local-test" };
const savedAllocation = {
  productId: "gpu", regionId: 1, instanceTypeId: "profile", imageHash: "ubuntu",
  rootStorageBlockId: "root", gpuCount: 2, poolId: 1,
  storage: { mode: "existing", volumeId: 1 },
  software: { kind: "huggingface", hfItemId: "org/model" },
  serviceId: "service", serviceType: "pod_accelerator",
  resources: { gpuName: "24GB GPU", gpuCount: 2, cpuCores: 4, ramGb: 8, rootStorageGb: 30, sharedStorageGb: 100, imageName: "Ubuntu" },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.podMetadata.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.huggingFaceDeployment.findFirst).mockResolvedValue({
    id: "deployment", subscriptionId: "instance", status: "pending", deployScript: "vllm",
    hfItemId: "org/model", servicePort: 8000, hfToken: null, openWebUI: false, netdata: false,
  } as HuggingFaceDeployment);
  vi.mocked(prisma.huggingFaceDeployment.updateMany).mockResolvedValue({ count: 1 });
  vi.mocked(executeRemoteScript).mockResolvedValue({ success: true, exitCode: 0, output: "Starting model" });
});

afterEach(() => vi.unstubAllEnvs());

describe("saved Hugging Face allocation execution", () => {
  it("runs tensor parallelism across the paid GPUs and keeps model weights on the selected persistent volume", async () => {
    vi.mocked(prisma.podMetadata.findFirst, { partial: true }).mockResolvedValue({ launchConfiguration: savedAllocation });
    await startPendingHuggingFaceDeployment("instance", credentials);
    const script = vi.mocked(executeRemoteScript).mock.calls[0]?.[4];
    expect(script).toContain("--tensor-parallel-size 2");
    expect(script).toContain('ln -s "$SHARE_PATH/hf-cache" "$WORKSPACE/cache"');
    expect(prisma.huggingFaceDeployment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "deploying", hfToken: null }) }));
  });

  it("fails a malformed configured allocation instead of installing for an invented one-GPU default", async () => {
    vi.mocked(prisma.podMetadata.findFirst, { partial: true }).mockResolvedValue({ launchConfiguration: { ...savedAllocation, gpuCount: 0 } });
    await startPendingHuggingFaceDeployment("instance", credentials);
    expect(executeRemoteScript).not.toHaveBeenCalled();
    expect(prisma.huggingFaceDeployment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: "failed", hfToken: null, errorMessage: expect.stringMatching(/saved.*allocation.*contact support/i),
    }) }));
  });

  it.each(["plaintext", "encrypted"])("starts historical %s credentials and clears the stored secret", async (format) => {
    vi.stubEnv("TENANT_ENCRYPTION_KEY", "a".repeat(64));
    const token = "hf_privateToken";
    const hfToken = format === "encrypted" ? encrypt(token) : token;
    if (format === "plaintext") vi.stubEnv("TENANT_ENCRYPTION_KEY", "");
    vi.mocked(prisma.huggingFaceDeployment.findFirst).mockResolvedValue({
      id: "deployment", status: "pending", deployScript: "vllm", hfItemId: "org/model", hfToken,
    } as HuggingFaceDeployment);
    await startPendingHuggingFaceDeployment("instance", credentials);
    expect(vi.mocked(executeRemoteScript).mock.calls[0]?.[4]).toContain(token);
    expect(prisma.huggingFaceDeployment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "deploying", hfToken: null }) }));
  });

  it.each(["malformed", "wrong-key", "missing-key", "invalid-plaintext"])("stops %s credentials permanently without attempting SSH or exposing secrets", async (failure) => {
    vi.stubEnv("TENANT_ENCRYPTION_KEY", "a".repeat(64));
    let hfToken = encrypt("hf_privateToken");
    if (failure === "malformed") hfToken = "bad:ciphertext:secret";
    if (failure === "invalid-plaintext") hfToken = "hf_privateToken; echo unsafe";
    if (failure === "wrong-key") vi.stubEnv("TENANT_ENCRYPTION_KEY", "b".repeat(64));
    if (failure === "missing-key") vi.stubEnv("TENANT_ENCRYPTION_KEY", "");
    vi.mocked(prisma.huggingFaceDeployment.findFirst).mockResolvedValue({
      id: "deployment", status: "pending", deployScript: "vllm", hfItemId: "org/model", hfToken,
    } as HuggingFaceDeployment);
    await startPendingHuggingFaceDeployment("instance", credentials);
    expect(executeRemoteScript).not.toHaveBeenCalled();
    const data = vi.mocked(prisma.huggingFaceDeployment.update).mock.calls.at(-1)?.[0].data;
    expect(data).toMatchObject({ status: "failed", hfToken: null, errorMessage: expect.stringMatching(/credential.*contact support/i) });
    expect(JSON.stringify(data)).not.toContain(hfToken);
    expect(JSON.stringify(data)).not.toContain("hf_privateToken");
  });

  it("sanitizes unknown remote exceptions and clears the credential", async () => {
    vi.mocked(executeRemoteScript).mockRejectedValue(new Error("SSH echoed hf_privateToken"));
    await startPendingHuggingFaceDeployment("instance", credentials);
    const data = vi.mocked(prisma.huggingFaceDeployment.update).mock.calls.at(-1)?.[0].data;
    expect(data).toMatchObject({ status: "failed", hfToken: null });
    expect(data?.errorMessage).not.toContain("hf_privateToken");
  });
});
