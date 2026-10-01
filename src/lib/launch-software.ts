import type { AuthenticatedCustomer } from "@/lib/auth/helpers";
import type { ResolvedLaunchConfiguration } from "@/lib/launch-config";
import { launchConfigurationSchema } from "@/lib/launch-config";
import { assertServiceSupportsLaunch } from "@/lib/launch-capabilities";
import { prisma } from "@/lib/prisma";
import { encrypt, decrypt, getTenantEncryptionKeyError, SecretEncryptionError } from "@/lib/crypto";
import { getCatalogItem, type DeployScriptType } from "@/lib/huggingface-catalog";
import { getModelInfo, estimateDiskSizeFromModel, isGatedModel, type HFModel } from "@/lib/huggingface-api";
import { generateDeployScript, getDefaultPort } from "@/lib/huggingface-deploy-scripts";
import { getSSHCredentials, executeRemoteScript, type SSHCredentials } from "@/lib/huggingface-status";
import { getStartupScriptPreset } from "@/lib/startup-scripts";

import { getModelRuntimeError, getFloat16VramGb } from "@/lib/launch-model-runtime";
import type { ModelRuntimeConfiguration } from "@/lib/launch-model-runtime";

const HF_TOKEN_PATTERN = /^hf_[a-zA-Z0-9]{1,253}$/;

class SavedLaunchAllocationError extends Error {}

export interface PreparedLaunchSoftware {
  serviceId?: string;
  startupScript?: string;
  startupScriptPresetId?: string;
  huggingFace?: { name: string; deployScript: DeployScriptType; encryptedToken?: string };
}

/** Remote programs can echo credentials in errors; never persist or return them. */
export function redactHuggingFaceSecrets(output: string): string {
  return output.replace(/hf_[a-zA-Z0-9_]+/g, "[REDACTED]");
}

async function resolveSoftware(auth: AuthenticatedCustomer, resolved: ResolvedLaunchConfiguration): Promise<PreparedLaunchSoftware> {
  const software = resolved.configuration.software;
  if (software.kind === "none") return {};
  if (software.kind === "startup") {
    if (software.presetId && software.script !== undefined) throw new Error("Choose a startup preset or a custom script, not both.");
    const preset = software.presetId ? getStartupScriptPreset(software.presetId) : undefined;
    if (software.presetId && !preset) throw new Error("Startup script preset is unavailable.");
    const script = preset?.script ?? software.script;
    if (!script?.trim()) throw new Error("A startup script is required.");
    return { startupScript: script, startupScriptPresetId: preset?.id };
  }
  if (software.kind === "recipe") {
    if (!auth.can("apps.use")) throw new Error("You do not have permission to deploy managed recipes.");
    const app = await prisma.gpuApp.findUnique({ where: { id: software.appId } });
    if (!app?.active || !app.deployable || !app.serviceId) throw new Error("This managed recipe is unavailable.");
    // Recipe services, not customer-provided service IDs, carry the admin-published Ansible recipe.
    await assertServiceSupportsLaunch(auth, resolved, app.serviceId);
    if (app.minVramGb > 0 && (!resolved.gpuVramGb || resolved.gpuVramGb < app.minVramGb)) {
      throw new Error(`This recipe requires at least ${app.minVramGb} GB VRAM per GPU.`);
    }
    return { serviceId: app.serviceId };
  }
  if (!auth.can("huggingface.use")) throw new Error("You do not have permission to deploy Hugging Face models.");
  if (!/^[\w.-]+(?:\/[\w.-]+)?$/.test(software.hfItemId) || software.hfItemId.includes("..")) throw new Error("Invalid Hugging Face model ID.");
  if (software.hfToken && !HF_TOKEN_PATTERN.test(software.hfToken)) throw new Error("Invalid Hugging Face token format.");
  if (software.hfToken && getTenantEncryptionKeyError()) {
    throw new Error("Hugging Face token encryption is not configured. Contact an administrator.");
  }
  const catalog = getCatalogItem(software.hfItemId);
  if (catalog && catalog.type !== "model") throw new Error("Select a Hugging Face model or an admin-published managed recipe. Arbitrary Docker images and Spaces are not supported by model launch.");
  let model: HFModel | null;
  if (software.hfToken) {
    // Authenticated metadata is deliberately not cached, keyed by token, or logged.
    const response = await fetch(`https://huggingface.co/api/models/${software.hfItemId}?blobs=true`, {
      headers: { Authorization: `Bearer ${software.hfToken}` }, cache: "no-store", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Unable to access this model with the supplied Hugging Face token.");
    model = await response.json() as HFModel;
  } else {
    model = await getModelInfo(software.hfItemId);
  }
  if (!model || model.disabled) throw new Error("This Hugging Face model is unavailable.");
  if ((catalog?.gated || isGatedModel(model) || model.private) && !software.hfToken) throw new Error("This model requires a Hugging Face token with approved model access.");
  if (model.pipeline_tag !== "text-generation" || model.library_name !== "transformers") {
    throw new Error("Model launch supports Transformers text-generation models only. Use a managed recipe for other runtimes.");
  }
  const configResponse = await fetch(`https://huggingface.co/${software.hfItemId}/resolve/main/config.json`, {
    headers: software.hfToken ? { Authorization: `Bearer ${software.hfToken}` } : undefined,
    cache: "no-store", signal: AbortSignal.timeout(15000),
  });
  if (!configResponse.ok) throw new Error("Unable to access this model's runtime configuration. Verify model access and any gated-model approval.");
  const runtime: unknown = await configResponse.json();
  if (!runtime || typeof runtime !== "object") throw new Error("Model runtime configuration is unavailable.");
  const modelConfig = runtime as ModelRuntimeConfiguration;
  const runtimeError = getModelRuntimeError(modelConfig);
  if (runtimeError) throw new Error(runtimeError);
  if (resolved.configuration.gpuCount > 1) {
    const dimensions = [
      ["attention heads", modelConfig.num_attention_heads],
      ["hidden size", modelConfig.hidden_size],
    ] as const;
    for (const [name, value] of dimensions) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Model ${name} could not be determined for multi-GPU tensor parallelism. Select one GPU or a model with published architecture dimensions.`);
      }
      if (value % resolved.configuration.gpuCount !== 0) {
        throw new Error(`Model ${name} (${value}) must be divisible by the selected GPU count (${resolved.configuration.gpuCount}) for tensor parallelism.`);
      }
    }
  }
  // Catalog hints may assume FP8/int4, while this runner explicitly uses float16.
  const float16VramGb = getFloat16VramGb(model);
  const requiredVram = float16VramGb > 0 ? Math.max(catalog?.vramGb ?? 0, float16VramGb) : 0;
  const modelDiskGb = Math.max(catalog?.diskSizeGb ?? 0, estimateDiskSizeFromModel(model));
  if (!(requiredVram > 0) || !(modelDiskGb > 0)) throw new Error("Model memory or disk requirements could not be determined. Select a model with published resource requirements.");
  if (!resolved.gpuVramGb || resolved.gpuVramGb * resolved.configuration.gpuCount < requiredVram) throw new Error(`This model requires approximately ${requiredVram} GB total GPU memory.`);
  // Baseline from the bundled vllm-server recipe: 4 cores, 8 GB RAM,
  // and 30 GB for the runtime, in addition to the model download.
  if (resolved.profile.cpuCores < 4 || resolved.profile.ramGb < 8) throw new Error("Model serving requires at least 4 CPU cores and 8 GB RAM.");
  if (resolved.rootStorage.sizeGb < 30) throw new Error("Model serving requires at least 30 GB root storage for the runtime.");
  const cacheGb = resolved.sharedStorage?.sizeGb ?? resolved.rootStorage.sizeGb - 30;
  if (cacheGb < modelDiskGb) throw new Error(`This model requires approximately ${modelDiskGb} GB model storage, in addition to 30 GB root storage for the runtime.`);
  return { huggingFace: { name: catalog?.name || software.hfItemId, deployScript: catalog?.deployScript || "vllm" } };
}

export async function validateLaunchSoftware(auth: AuthenticatedCustomer, resolved: ResolvedLaunchConfiguration): Promise<void> {
  await resolveSoftware(auth, resolved);
}

export async function prepareLaunchSoftware(auth: AuthenticatedCustomer, resolved: ResolvedLaunchConfiguration): Promise<PreparedLaunchSoftware> {
  const prepared = await resolveSoftware(auth, resolved);
  const software = resolved.configuration.software;
  if (prepared.huggingFace && software.kind === "huggingface" && software.hfToken) {
    // Fail before payment if secret encryption is unavailable.
    prepared.huggingFace.encryptedToken = encrypt(software.hfToken);
  }
  return prepared;
}

/** Starts installation only after the unified instance and its billing metadata exist. */
export async function completeLaunchSoftware(auth: AuthenticatedCustomer, resolved: ResolvedLaunchConfiguration, prepared: PreparedLaunchSoftware, instanceId: string): Promise<void> {
  const software = resolved.configuration.software;
  if (software.kind !== "huggingface" || !prepared.huggingFace) return;
  await prisma.huggingFaceDeployment.create({ data: {
    subscriptionId: instanceId, stripeCustomerId: auth.accountId,
    hfItemId: software.hfItemId, hfItemType: "model", hfItemName: prepared.huggingFace.name,
    deployScript: prepared.huggingFace.deployScript, status: "pending",
    servicePort: getDefaultPort(prepared.huggingFace.deployScript),
    openWebUI: software.openWebUI ?? false, webUiPort: software.openWebUI ? 3000 : null,
    netdata: software.netdata ?? false, netdataPort: software.netdata ? 19999 : null,
    hfToken: prepared.huggingFace.encryptedToken ?? null,
  } });
  // A later status poll can also claim pending work if the process is recycled.
  void startPendingHuggingFaceDeployment(instanceId).catch(() => {
    console.error("[HF Launch] Could not initiate installation", instanceId);
  });
}

/** Atomically claims pending work; successful script submission is not readiness. */
export async function startPendingHuggingFaceDeployment(instanceId: string, credentials?: SSHCredentials): Promise<void> {
  const creds = credentials ?? await getSSHCredentials(instanceId);
  if (!creds) return; // Provisioning: a later poll will retry without pretending installation started.
  const deployment = await prisma.huggingFaceDeployment.findFirst({ where: { subscriptionId: instanceId, status: "pending" }, orderBy: { createdAt: "desc" } });
  if (!deployment) return;
  const claimed = await prisma.huggingFaceDeployment.updateMany({ where: { id: deployment.id, status: "pending" }, data: { status: "deploying", errorMessage: null } });
  if (!claimed.count) return;
  try {
    const metadata = await prisma.podMetadata.findFirst({ where: { OR: [{ instanceId }, { subscriptionId: instanceId }, { subscriptionId: `instance-${instanceId}` }] } });
    const parsed = launchConfigurationSchema.strip().safeParse(metadata?.launchConfiguration);
    if (metadata?.launchConfiguration != null && !parsed.success) {
      throw new SavedLaunchAllocationError("The saved instance allocation is invalid. Contact support before retrying installation.");
    }
    const configuration = parsed.success ? parsed.data : null;
    // Preserve historical pending deployments, whose plaintext token predates encrypted storage.
    let token: string | undefined;
    if (deployment.hfToken) {
      token = HF_TOKEN_PATTERN.test(deployment.hfToken) ? deployment.hfToken : decrypt(deployment.hfToken);
      if (!HF_TOKEN_PATTERN.test(token)) throw new SecretEncryptionError("Stored Hugging Face credential is invalid.");
    }
    const script = generateDeployScript(deployment.deployScript as DeployScriptType, {
      modelId: deployment.hfItemId, hfToken: token, gpuCount: configuration?.gpuCount ?? 1,
      port: deployment.servicePort ?? getDefaultPort(deployment.deployScript as DeployScriptType),
      openWebUI: deployment.openWebUI, netdata: deployment.netdata,
      sharedModelStorage: configuration ? configuration.storage.mode !== "none" : false,
    });
    const result = await executeRemoteScript(creds.host, creds.port, creds.username, creds.password, script);
    await prisma.huggingFaceDeployment.update({ where: { id: deployment.id }, data: {
      status: result.success ? "deploying" : "failed",
      errorMessage: result.success ? null : `Model installation failed (exit ${result.exitCode}).`,
      deployOutput: redactHuggingFaceSecrets(result.output).slice(-5000),
      // No retrigger of a failed installation on a read; token is no longer needed.
      hfToken: null,
    } });
  } catch (error) {
    const errorMessage = error instanceof SavedLaunchAllocationError
      ? error.message
      : error instanceof SecretEncryptionError
        ? "The stored model credential or encryption configuration is invalid. Contact support before retrying installation."
        : "Unable to start model installation. Check instance access and retry installation.";
    await prisma.huggingFaceDeployment.update({ where: { id: deployment.id }, data: { status: "failed", errorMessage, hfToken: null } });
  }
}
