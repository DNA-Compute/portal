import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedCustomer } from "@/lib/auth/helpers";
import type { ResolvedLaunchConfiguration } from "@/lib/launch-config";
import type { HFModel } from "@/lib/huggingface-api";

vi.mock("@/lib/prisma", () => ({ prisma: { gpuApp: { findUnique: vi.fn() }, huggingFaceDeployment: { create: vi.fn() } } }));
vi.mock("@/lib/launch-capabilities", () => ({ assertServiceSupportsLaunch: vi.fn() }));
vi.mock("@/lib/huggingface-api", () => ({
  getModelInfo: vi.fn(),
  estimateDiskSizeFromModel: vi.fn().mockReturnValue(20),
  isGatedModel: vi.fn().mockReturnValue(false),
}));
vi.mock("@/lib/huggingface-catalog", () => ({ getCatalogItem: vi.fn() }));
vi.mock("@/lib/huggingface-status", () => ({ getSSHCredentials: vi.fn().mockResolvedValue(null), executeRemoteScript: vi.fn() }));

import { completeLaunchSoftware, prepareLaunchSoftware, redactHuggingFaceSecrets, validateLaunchSoftware } from "@/lib/launch-software";
import { withoutLaunchSecrets } from "@/lib/launch-config";
import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import { getModelInfo } from "@/lib/huggingface-api";
import { getCatalogItem } from "@/lib/huggingface-catalog";

const model = {
  id: "org/model", disabled: false, pipeline_tag: "text-generation", library_name: "transformers",
  safetensors: { total: Math.floor(40 * (1024 ** 3) / 2.4) },
} as HFModel;

const allowAllPermissions: AuthenticatedCustomer["can"] = () => true;
const auth = { accountId: "account-1", can: allowAllPermissions } as AuthenticatedCustomer;

function allocation(): ResolvedLaunchConfiguration {
  return {
    configuration: { productId: "gpu", regionId: 1, instanceTypeId: "profile", imageHash: "ubuntu", rootStorageBlockId: "root", gpuCount: 2, poolId: 1, storage: { mode: "none" }, software: { kind: "huggingface", hfItemId: "org/model" } },
    serviceId: "service", serviceType: "pod_accelerator", productName: "GPU", billingType: "hourly", gpuBaseHourCents: 100, configurationPricing: null,
    profile: { id: "profile", name: "4 CPU / 8GB", cpuCores: 4, ramGb: 8 },
    image: { id: "ubuntu", name: "Ubuntu" }, rootStorage: { id: "root", name: "50GB", sizeGb: 50 }, sharedStorage: null, gpuName: "24GB GPU", gpuVramGb: 24,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(getModelInfo).mockResolvedValue(model);
  vi.mocked(getCatalogItem).mockReturnValue(undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ architectures: ["LlamaForCausalLM"], num_attention_heads: 64, hidden_size: 8192 }) }));
});

describe("software allocation compatibility", () => {
  it("uses total selected whole-GPU memory rather than a one-GPU default", async () => {
    const resolved = allocation();
    await expect(prepareLaunchSoftware(auth, resolved)).resolves.toMatchObject({ huggingFace: { name: "org/model" } });
    resolved.configuration.gpuCount = 1;
    await expect(validateLaunchSoftware(auth, resolved)).rejects.toThrow("40 GB total GPU memory");
  });

  it("rejects three GPUs for 64 attention heads despite sufficient aggregate VRAM", async () => {
    const resolved = allocation();
    resolved.configuration.gpuCount = 3;
    await expect(validateLaunchSoftware(auth, resolved)).rejects.toThrow("attention heads (64) must be divisible by the selected GPU count (3)");
  });

  it("does not guess missing tensor-parallel dimensions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ architectures: ["LlamaForCausalLM"], num_attention_heads: 64 }) }));
    await expect(validateLaunchSoftware(auth, allocation())).rejects.toThrow("hidden size could not be determined");
  });

  it("does not count shared capacity as runtime root capacity", async () => {
    const resolved = allocation();
    resolved.configuration.storage = { mode: "existing", volumeId: 1 };
    resolved.sharedStorage = { id: 1, name: "Cache", sizeGb: 20 };
    resolved.rootStorage.sizeGb = 30;
    await expect(prepareLaunchSoftware(auth, resolved)).resolves.toMatchObject({ huggingFace: { name: "org/model" } });
    resolved.rootStorage.sizeGb = 29;
    await expect(validateLaunchSoftware(auth, resolved)).rejects.toThrow("30 GB root storage");
    resolved.rootStorage.sizeGb = 30;
    resolved.sharedStorage.sizeGb = 19;
    await expect(validateLaunchSoftware(auth, resolved)).rejects.toThrow("20 GB model storage");
  });

  it("rejects insufficient RAM even when GPU and disks fit", async () => {
    const resolved = allocation();
    resolved.profile.ramGb = 4;
    await expect(validateLaunchSoftware(auth, resolved)).rejects.toThrow("8 GB RAM");
  });

  it("does not accept optimistic FP8 catalog memory for the float16 runtime", async () => {
    const resolved = allocation();
    resolved.gpuVramGb = 48;
    vi.mocked(getCatalogItem).mockReturnValue({
      id: "org/model", type: "model", name: "72B", description: "", tags: [], gated: false,
      deployScript: "vllm", vramGb: 82,
    });
    vi.mocked(getModelInfo).mockResolvedValue({ ...model, safetensors: { total: 72_000_000_000 } });
    await expect(validateLaunchSoftware(auth, resolved)).rejects.toThrow("161 GB total GPU memory");
  });

  it("rejects diffusion models even when their weights fit", async () => {
    vi.mocked(getModelInfo).mockResolvedValue({ ...model, pipeline_tag: "text-to-image", library_name: "diffusers" });
    await expect(validateLaunchSoftware(auth, allocation())).rejects.toThrow("Transformers text-generation models only");
  });

  it("rejects unsupported custom architectures rather than provisioning an incompatible engine", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ architectures: ["CustomVideoGenerationModel"] }) }));
    await expect(validateLaunchSoftware(auth, allocation())).rejects.toThrow("architecture is not supported");
  });

  it("rejects pre-quantized checkpoints for the float16-only runner", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ architectures: ["LlamaForCausalLM"], quantization_config: { quant_method: "fp8" } }),
    }));
    await expect(validateLaunchSoftware(auth, allocation())).rejects.toThrow("Pre-quantized models are not supported");
  });
});

describe("Hugging Face secret handling", () => {
  it("requires encryption before accepting a token-bearing launch", async () => {
    vi.stubEnv("TENANT_ENCRYPTION_KEY", "");
    const resolved = allocation();
    resolved.configuration.software = { kind: "huggingface", hfItemId: "org/model", hfToken: "hf_privateToken" };
    await expect(validateLaunchSoftware(auth, resolved)).rejects.toThrow("encryption is not configured");
  });

  it("keeps public models available without token encryption configuration", async () => {
    vi.stubEnv("TENANT_ENCRYPTION_KEY", "");
    await expect(prepareLaunchSoftware(auth, allocation())).resolves.toMatchObject({ huggingFace: { name: "org/model" } });
  });

  it("persists only ciphertext and excludes the token from configuration snapshots", async () => {
    vi.stubEnv("TENANT_ENCRYPTION_KEY", "a".repeat(64));
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => model })
      .mockResolvedValue({ ok: true, json: async () => ({ architectures: ["LlamaForCausalLM"], num_attention_heads: 64, hidden_size: 8192 }) }));
    const resolved = allocation();
    const token = "hf_privateToken";
    resolved.configuration.software = { kind: "huggingface", hfItemId: "org/model", hfToken: token };
    const prepared = await prepareLaunchSoftware(auth, resolved);
    expect(JSON.stringify(prepared)).not.toContain(token);
    expect(JSON.stringify(withoutLaunchSecrets(resolved.configuration))).not.toContain(token);
    await completeLaunchSoftware(auth, resolved, prepared, "i-gpu");
    const persisted = vi.mocked(prisma.huggingFaceDeployment.create).mock.calls.at(-1)?.[0].data;
    expect(persisted?.hfToken).not.toBe(token);
    expect(decrypt(String(persisted?.hfToken))).toBe(token);
    expect(redactHuggingFaceSecrets(`Authorization: Bearer ${token}\nmodel ready`)).toBe("Authorization: Bearer [REDACTED]\nmodel ready");
  });
});
