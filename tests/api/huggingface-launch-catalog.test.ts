import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { HFModel } from "@/lib/huggingface-api";
import type { HFCatalogItem } from "@/lib/huggingface-catalog";
import type { LaunchModelSupport } from "@/lib/launch-model-runtime";

vi.mock("@/lib/customer-auth", () => ({ verifyCustomerToken: () => ({ customerId: "account", email: "user@example.com" }) }));
vi.mock("@/lib/auth/account-resolver", () => ({ resolveOperatingContext: async () => ({ accountId: "account", customer: { email: "user@example.com" } }) }));
vi.mock("@/lib/auth/gate", () => ({ gatePermission: async () => null }));
vi.mock("@/lib/hostedai", () => ({ getAllPools: vi.fn() }));
vi.mock("@/lib/hf-mem", () => ({ getModelMemory: vi.fn() }));
vi.mock("@/lib/huggingface-api", () => ({ getModelInfo: vi.fn(), isGatedModel: (model: { gated?: boolean }) => !!model.gated }));
vi.mock("@/lib/huggingface-catalog", () => {
  const items = ["original", "quantized", "custom", "gated", "missing", "private"].map(name => ({
    id: `org/${name}`, type: "model", name, description: "", tags: [], gated: name === "gated", vramGb: 2, deployScript: "vllm",
  }));
  return {
    HF_CATALOG: { popular: items }, getCatalogByType: () => items,
    getCatalogItem: (id: string) => items.find(item => item.id === id),
    getAllCatalogItems: () => items, searchCatalog: () => items, getRtxOptimizedModels: () => items,
  };
});

import { GET } from "@/app/api/huggingface/catalog/route";
import { getModelInfo } from "@/lib/huggingface-api";
import { getModelMemory } from "@/lib/hf-mem";

afterEach(() => vi.unstubAllGlobals());

function request(query: string) {
  return new NextRequest(`http://localhost/api/huggingface/catalog?${query}`, { headers: { Authorization: "Bearer test-session" } });
}

describe("launch-facing Hugging Face catalog", () => {
  it("flags incompatible runtimes, leaves inaccessible metadata unverified, and shares public downloads", async () => {
    vi.mocked(getModelInfo).mockImplementation(async id => id.endsWith("missing") ? null : ({
      id, pipeline_tag: "text-generation", library_name: "transformers",
      gated: id.endsWith("gated"), private: id.endsWith("private"), safetensors: { total: 72_000_000_000 },
    } as HFModel));
    const fetchMock = vi.fn(async (url: string) => ({
      ok: !url.includes("/gated/"),
      json: async () => ({
        architectures: [url.includes("/custom/") ? "UnsupportedModel" : "LlamaForCausalLM"],
        ...(url.includes("/quantized/") ? { quantization_config: { quant_method: "fp8" } } : {}),
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const responses = await Promise.all([GET(request("type=model&launch=true")), GET(request("type=model&launch=true"))]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const body = await responses[0].json() as { items: (HFCatalogItem & { launchSupport: LaunchModelSupport })[] };
    const models = Object.fromEntries(body.items.map(item => [item.id, item]));
    expect(models["org/original"]).toMatchObject({ vramGb: 161, launchSupport: { status: "supported" } });
    expect(models["org/quantized"].launchSupport.status).toBe("unsupported");
    expect(models["org/custom"].launchSupport.status).toBe("unsupported");
    expect(models["org/gated"].launchSupport.status).toBe("unverified");
    expect(models["org/missing"].launchSupport.status).toBe("unverified");
    expect(models["org/private"].launchSupport.status).toBe("unverified");
    expect(models["org/quantized"].vramGb).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(getModelMemory).not.toHaveBeenCalled();
    await GET(request("id=org/original&launch=true"));
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("preserves general browse results without launch-only checks or changed memory hints", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(request("type=model"));
    const body = await response.json() as { items: (HFCatalogItem & { launchSupport?: LaunchModelSupport })[] };
    expect(body.items.find(item => item.id === "org/quantized")).toMatchObject({ vramGb: 2 });
    expect(body.items.every(item => item.launchSupport === undefined)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
