import { getModelInfo, isGatedModel } from "@/lib/huggingface-api";
import type { HFModel } from "@/lib/huggingface-api";

// Native causal-LM architectures supported by the existing float16 vLLM runner.
const SUPPORTED_MODEL_ARCHITECTURES: Record<string, true> = {
  LlamaForCausalLM: true, MistralForCausalLM: true, MixtralForCausalLM: true,
  Qwen2ForCausalLM: true, GemmaForCausalLM: true, Gemma2ForCausalLM: true,
  PhiForCausalLM: true, Phi3ForCausalLM: true, GPTNeoXForCausalLM: true,
  OPTForCausalLM: true, FalconForCausalLM: true,
};

export interface ModelRuntimeConfiguration {
  architectures?: unknown;
  quantization_config?: unknown;
  num_attention_heads?: unknown;
  hidden_size?: unknown;
}

export interface LaunchModelSupport {
  status: "supported" | "unsupported" | "unverified";
  message: string;
  float16VramGb?: number;
}

export function getModelRuntimeError(runtime: ModelRuntimeConfiguration): string | null {
  if (runtime.quantization_config) {
    return "Pre-quantized models are not supported by the float16 launch runtime. Select the original model or a managed recipe.";
  }
  if (!Array.isArray(runtime.architectures) || !runtime.architectures.length ||
      !runtime.architectures.every(architecture => typeof architecture === "string" && Object.hasOwn(SUPPORTED_MODEL_ARCHITECTURES, architecture))) {
    return "This model architecture is not supported by the configured vLLM runtime.";
  }
  return null;
}

export function getFloat16VramGb(model: HFModel): number {
  const parameterCount = model.safetensors?.total ||
    Object.values(model.safetensors?.parameters ?? {}).reduce((sum, count) => sum + count, 0);
  return Number.isFinite(parameterCount) && parameterCount > 0
    ? Math.ceil(parameterCount * 2 * 1.2 / (1024 ** 3)) : 0;
}

const unverified: LaunchModelSupport = {
  status: "unverified",
  message: "Runtime compatibility is unverified. Model access and compatibility will be checked before launch; gated/private models require an approved access token.",
};

// Public catalog checks only. Never cache authenticated model/config responses or tokens.
// Cache the in-flight promise too, so simultaneous picker requests share downloads.
const supportCache = new Map<string, { result: Promise<LaunchModelSupport>; expiresAt: number }>();
const SUPPORT_CACHE_TTL = 60 * 60 * 1000;
const UNVERIFIED_CACHE_TTL = 5 * 60 * 1000;

export async function getPublicLaunchModelSupport(modelId: string): Promise<LaunchModelSupport> {
  const cached = supportCache.get(modelId);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const entry = { result: inspectPublicModel(modelId), expiresAt: Date.now() + SUPPORT_CACHE_TTL };
  supportCache.set(modelId, entry);
  const result = await entry.result;
  if (result.status === "unverified") entry.expiresAt = Date.now() + UNVERIFIED_CACHE_TTL;
  return result;
}

async function inspectPublicModel(modelId: string): Promise<LaunchModelSupport> {
  try {
    const model = await getModelInfo(modelId);
    if (!model) return unverified;
    if (model.disabled) return { status: "unsupported", message: "This model is disabled on Hugging Face." };
    if ((model.pipeline_tag && model.pipeline_tag !== "text-generation") ||
        (model.library_name && model.library_name !== "transformers")) {
      return { status: "unsupported", message: "Model launch supports Transformers text-generation models only. Use a managed recipe for other runtimes." };
    }
    const response = await fetch(`https://huggingface.co/${modelId}/resolve/main/config.json`, {
      cache: "no-store", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return unverified;
    const runtime: unknown = await response.json();
    if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return unverified;
    const config = runtime as ModelRuntimeConfiguration;
    // Missing architecture metadata is not evidence of an unsupported architecture.
    if ((!Array.isArray(config.architectures) || !config.architectures.length) && !config.quantization_config) return unverified;
    const error = getModelRuntimeError(config);
    if (error) return { status: "unsupported", message: error };
    const float16VramGb = getFloat16VramGb(model);
    if (!model.pipeline_tag || !model.library_name || model.private || isGatedModel(model) || !float16VramGb) return unverified;
    return { status: "supported", message: "Float16 runtime supported. GPU, storage, and model access are checked before launch.", float16VramGb };
  } catch {
    return unverified;
  }
}
