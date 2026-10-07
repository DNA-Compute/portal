"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { launchConfigurationSchema, type ConfigurationPricing, type LaunchCapabilities, type LaunchConfiguration, type LaunchQuote } from "@/lib/launch-config";
import { LaunchSoftwarePicker, type SoftwareSelectionMetadata } from "./LaunchSoftwarePicker";
import { ChoiceCard, Select, ui } from "./launch-ui";

interface LaunchProduct {
  id: string; name: string; gpuFamily: string | null; billingType: string;
  configurationPricing?: ConfigurationPricing | null; vramGb: number | null; pricePerHourCents?: number;
}
interface LaunchOptions {
  products: LaunchProduct[];
  categories?: { slug: string; products: LaunchProduct[] }[];
  sshKeys: { id: string; name: string; fingerprint: string }[];
  teamId: string;
  walletBalanceCents: number;
}
/** Entry-point metadata only. Resource creation always uses the configured instances API. */
export interface DeployContext {
  type: "huggingface" | "app";
  title: string;
  subtitle?: string;
  modelId: string;
  isGated?: boolean | string;
  vramGb?: number;
  openWebUI?: boolean;
}
interface Props {
  isOpen: boolean; onClose: () => void; token: string;
  onSuccess: (info: { name: string; poolName: string; instanceId?: string }) => void;
  onError?: (message: string) => void;
  initialProductId?: string; initialCategorySlug?: string; lockedProductId?: string;
  stripeSubscriptionId?: string; deployContext?: DeployContext;
}
interface Draft {
  version: 1; teamId: string; configuration: LaunchConfiguration;
  name: string; sshKeyIds: string[]; step: number;
  lockedProductId?: string; stripeSubscriptionId?: string;
  ownerAccountId?: string; categorySlug?: string;
  metadata: SoftwareSelectionMetadata | null;
}
const DRAFT_KEY = "dna.launch-configuration.v1";
const steps = ["GPU & region", "Resources", "Software", "Access", "Review"];
const stepIntros = [
  "Pick the GPU you want and where it runs.",
  "Size the machine around your GPU. Every option listed is supported for this selection.",
  "",
  "Name this GPU and choose which SSH keys can reach it.",
  "Check the itemised price before you launch.",
];
const emptyConfiguration: LaunchConfiguration = { productId: "", regionId: 0, instanceTypeId: "", imageHash: "", rootStorageBlockId: "", gpuCount: 0, storage: { mode: "none" }, software: { kind: "none" } };
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 });
const money = (cents: number) => usd.format(cents / 100);
const shareNames: Record<number, string> = { 100: "Whole GPU", 75: "Three quarters of a GPU", 50: "Half a GPU", 25: "Quarter of a GPU" };
function draftConfiguration(configuration: LaunchConfiguration): LaunchConfiguration {
  const software = configuration.software;
  if (software.kind === "huggingface") return { ...configuration, software: { kind: software.kind, hfItemId: software.hfItemId, openWebUI: software.openWebUI, netdata: software.netdata } };
  if (software.kind === "startup") return { ...configuration, software: { kind: software.kind, presetId: software.presetId } };
  return configuration;
}
function readDraft(): Draft | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null");
    if (value?.version !== 1 || typeof value.teamId !== "string" || typeof value.name !== "string" || !Array.isArray(value.sshKeyIds)) return null;
    // Incomplete resource choices are useful drafts, but must pass the full schema before quoting.
    const fields = Object.fromEntries(Object.entries(value.configuration || {}).filter(([, entry]) => entry !== "" && entry !== 0));
    const parsed = launchConfigurationSchema.partial().safeParse(fields);
    if (!parsed.success) return null;
    return { ...value, configuration: { ...emptyConfiguration, ...parsed.data } };
  } catch { return null; }
}

export function LaunchConfigurator(props: Props) {
  // Unmount on close so access tokens and custom scripts never survive a closed wizard.
  return props.isOpen ? <ConfiguratorSession {...props} /> : null;
}

function ConfiguratorSession({ onClose, token, onSuccess, onError, initialProductId, initialCategorySlug, lockedProductId, stripeSubscriptionId, deployContext }: Props) {
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [configuration, setConfiguration] = useState<LaunchConfiguration>(() => ({
    ...emptyConfiguration,
    productId: lockedProductId || initialProductId || "",
    software: deployContext ? deployContext.type === "huggingface" ? { kind: "huggingface", hfItemId: deployContext.modelId, openWebUI: deployContext.openWebUI } : { kind: "recipe", appId: deployContext.modelId } : { kind: "none" },
  }));
  const [capabilityResult, setCapabilityResult] = useState<{ key: string; value: LaunchCapabilities } | null>(null);
  const [capabilityLoading, setCapabilityLoading] = useState(false);
  const [capabilityError, setCapabilityError] = useState("");
  const [bootstrapError, setBootstrapError] = useState("");
  const [name, setName] = useState("");
  const [sshKeyIds, setSshKeyIds] = useState<string[]>([]);
  const [step, setStep] = useState(0);
  const [entitlement, setEntitlement] = useState({ productId: lockedProductId, subscriptionId: stripeSubscriptionId });
  const [metadata, setMetadata] = useState<SoftwareSelectionMetadata | null>(() => deployContext ? { id: deployContext.modelId, name: deployContext.title.replace(/^Deploy /, ""), description: deployContext.subtitle, gated: deployContext.isGated, vramGb: deployContext.vramGb } : null);
  const [quoteResult, setQuoteResult] = useState<{ key: string; value: LaunchQuote } | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [reviewedFingerprint, setReviewedFingerprint] = useState("");
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState<{ instanceId?: string; warning: string; configurationSaved: boolean } | null>(null);
  const [launching, setLaunching] = useState(false);
  const [funding, setFunding] = useState(false);
  const [amounts, setAmounts] = useState<{ value: number; label: string }[]>([]);
  const [reload, setReload] = useState(0);
  const [capabilityRevision, setCapabilityRevision] = useState(0);
  const [quoteRevision, setQuoteRevision] = useState(0);
  const [restored, setRestored] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = () => {
    if (accepted) onSuccess({ name: name.trim(), poolName: options?.products.find(item => item.id === configuration.productId)?.name || "GPU", instanceId: accepted.instanceId });
    onClose();
  };
  const busyRef = useRef(false);
  // This claim only scopes an unprovisioned local draft. Server APIs authorize every operation.
  const draftAccountId = useMemo(() => {
    try {
      const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      const accountId = claims.activeAccountId || claims.customerId;
      return typeof accountId === "string" ? accountId : undefined;
    } catch { return undefined; }
  }, [token]);
  busyRef.current = launching || funding;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    title.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const targets = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') || []).filter(element => element.getClientRects().length);
      const first = targets[0]; const last = targets[targets.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === title.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setBootstrapError("");
    async function load() {
      try {
        const response = await fetch("/api/instances/launch-options", { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
        const data: LaunchOptions & { error?: string } = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load GPU offerings");
        if (controller.signal.aborted) return;
        const draft = readDraft();
        const explicitProduct = lockedProductId || initialProductId;
        const matchingDraft = draft && (draft.teamId === String(data.teamId) || (!draft.teamId && !!draftAccountId && draft.ownerAccountId === draftAccountId))
          && (!explicitProduct || draft.configuration.productId === explicitProduct)
          && (!stripeSubscriptionId || draft.stripeSubscriptionId === stripeSubscriptionId)
          && (!deployContext || (deployContext.type === "huggingface" ? draft.configuration.software.kind === "huggingface" && draft.configuration.software.hfItemId === deployContext.modelId : draft.configuration.software.kind === "recipe" && draft.configuration.software.appId === deployContext.modelId));
        const category = data.categories?.find(item => item.slug === (initialCategorySlug || (matchingDraft ? draft.categorySlug : undefined)));
        const candidates = (category?.products || data.products).filter(product => product.billingType !== "monthly");
        const product = explicitProduct || (matchingDraft ? draft.configuration.productId : undefined) || candidates.find(product => product.configurationPricing)?.id || candidates[0]?.id || "";
        setOptions(data);
        if (matchingDraft && data.products.some(item => item.id === product)) {
          setConfiguration({ ...draft.configuration, productId: product });
          setName(draft.name.slice(0, 128));
          setSshKeyIds(draft.sshKeyIds.filter(id => typeof id === "string" && data.sshKeys.some(key => key.id === id)));
          setEntitlement({ productId: lockedProductId || draft.lockedProductId, subscriptionId: stripeSubscriptionId || draft.stripeSubscriptionId });
          setMetadata(draft.metadata);
          setStep(Math.min(4, Math.max(0, Number.isInteger(draft.step) ? draft.step : 0)));
          setRestored(true);
        } else {
          setConfiguration({ ...emptyConfiguration, productId: product, software: deployContext ? deployContext.type === "huggingface" ? { kind: "huggingface", hfItemId: deployContext.modelId, openWebUI: deployContext.openWebUI } : { kind: "recipe", appId: deployContext.modelId } : { kind: "none" } });
          if (deployContext) setMetadata({ id: deployContext.modelId, name: deployContext.title.replace(/^Deploy /, ""), description: deployContext.subtitle, gated: deployContext.isGated, vramGb: deployContext.vramGb });
        }
      } catch (err) { if (!controller.signal.aborted) setBootstrapError(err instanceof Error ? err.message : "Unable to load GPU offerings"); }
    }
    void load();
    return () => controller.abort();
    // Preselection is captured once per mounted session; parent keys separate intents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, reload]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/account/wallet-topup", { signal: controller.signal }).then(response => response.ok ? response.json() : Promise.reject()).then(data => { if (!controller.signal.aborted) setAmounts(data.amounts || []); }).catch(() => {});
    return () => controller.abort();
  }, []);
  const capKey = [configuration.productId, configuration.regionId, configuration.poolId || "", configuration.gpuModelId || "", configuration.gpuCount, configuration.gpuSharePercent || "", configuration.imageHash, configuration.instanceTypeId].join(":");
  const capabilities = capabilityResult?.key === capKey ? capabilityResult.value : null;
  useEffect(() => {
    if (!configuration.productId || !options) return;
    const controller = new AbortController();
    setCapabilityLoading(true); setCapabilityError("");
    async function load() {
      try {
        const params = new URLSearchParams({ product_id: configuration.productId });
        if (configuration.regionId) params.set("region_id", String(configuration.regionId));
        if (configuration.poolId) params.set("pool_id", String(configuration.poolId));
        if (configuration.gpuModelId) params.set("gpu_model_id", configuration.gpuModelId);
        if (configuration.gpuCount) params.set("gpu_count", String(configuration.gpuCount));
        if (configuration.gpuSharePercent) params.set("gpu_share_percent", String(configuration.gpuSharePercent));
        if (configuration.imageHash) params.set("image_hash", configuration.imageHash);
        if (configuration.instanceTypeId) params.set("instance_type_id", configuration.instanceTypeId);
        const response = await fetch(`/api/instances/configuration?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load supported resources");
        if (controller.signal.aborted) return;
        const caps: LaunchCapabilities = data.capabilities;
        setConfiguration(current => {
          const pick = (currentId: string, choices: { id: string }[], defaultId: string | undefined, locked: boolean) => !locked && choices.some(item => item.id === currentId) ? currentId : choices.find(item => item.id === defaultId)?.id || choices[0]?.id || "";
          const regionId = caps.regions.some(region => region.id === current.regionId) ? current.regionId : caps.regionId || caps.regions[0]?.id || 0;
          const currentStorage = current.storage;
          const storage = regionId !== current.regionId ? { mode: "none" as const } : !caps.rootStorageBlocks.length ? currentStorage : currentStorage.mode === "existing" ? caps.volumes.some(volume => volume.id === currentStorage.volumeId && volume.regionId === regionId) ? currentStorage : { mode: "none" as const } : currentStorage.mode === "new" ? caps.sharedStorageBlocks.some(block => block.id === currentStorage.blockId) ? currentStorage : { mode: "none" as const } : currentStorage;
          return { ...current, regionId,
            instanceTypeId: pick(current.instanceTypeId, caps.profiles, caps.defaults.instanceTypeId, caps.locks.profile),
            imageHash: pick(current.imageHash, caps.images, caps.defaults.imageHash, caps.locks.image),
            rootStorageBlockId: pick(current.rootStorageBlockId, caps.rootStorageBlocks, caps.defaults.rootStorageBlockId, caps.locks.rootStorage),
            poolId: caps.serviceType === "pod_accelerator" ? (!caps.locks.pool && caps.pools.some(pool => pool.id === current.poolId) ? current.poolId : caps.defaults.poolId || caps.pools[0]?.id) : undefined,
            gpuModelId: caps.serviceType === "cpu_gpu_card" ? (caps.gpuModels.some(model => model.id === current.gpuModelId) ? current.gpuModelId : caps.defaults.gpuModelId || caps.gpuModels[0]?.id) : undefined,
            // Clamp defaults too, so an empty region cannot oscillate between zero and its default count.
            gpuCount: Math.min(caps.locks.gpuCount || !current.gpuCount ? caps.defaults.gpuCount || 0 : current.gpuCount, caps.maxGpuCount), storage,
            gpuSharePercent: caps.defaults.gpuSharePercent,
          };
        });
        setCapabilityResult({ key: capKey, value: caps });
      } catch (err) { if (!controller.signal.aborted) setCapabilityError(err instanceof Error ? err.message : "Unable to load supported resources"); }
      finally { if (!controller.signal.aborted) setCapabilityLoading(false); }
    }
    void load();
    return () => controller.abort();
    // Only provider selection changes require new capability discovery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capKey, token, options, capabilityRevision]);

  useEffect(() => {
    if (!options || accepted) return;
    const draft: Draft = { version: 1, teamId: String(options.teamId), configuration: draftConfiguration(configuration), name, sshKeyIds, step, lockedProductId: entitlement.productId, stripeSubscriptionId: entitlement.subscriptionId, metadata };
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* Storage may be disabled; launch itself still works. */ }
  }, [options, configuration, name, sshKeyIds, step, entitlement, metadata, accepted]);

  const softwareValid = configuration.software.kind === "none" || configuration.software.kind === "recipe" && !!configuration.software.appId || configuration.software.kind === "huggingface" && !!configuration.software.hfItemId && (!(metadata?.id === configuration.software.hfItemId && metadata.gated) || !!configuration.software.hfToken?.trim()) || configuration.software.kind === "startup" && !!(configuration.software.presetId || configuration.software.script?.trim());
  const parsed = launchConfigurationSchema.safeParse({ ...configuration, software: { kind: "none" } });
  const resourcesValid = !!capabilities && parsed.success && capabilities.profiles.some(profile => profile.id === configuration.instanceTypeId) && capabilities.images.some(image => image.id === configuration.imageHash) && capabilities.rootStorageBlocks.some(block => block.id === configuration.rootStorageBlockId) && configuration.gpuCount <= capabilities.maxGpuCount && (capabilities.serviceType === "pod_accelerator" ? capabilities.pools.some(pool => pool.id === configuration.poolId) : capabilities.gpuModels.some(model => model.id === configuration.gpuModelId));
  const configurationKey = JSON.stringify(configuration);
  const quote = quoteResult?.key === configurationKey && resourcesValid && softwareValid ? quoteResult.value : null;
  useEffect(() => {
    setQuoteResult(null); setReviewedFingerprint(""); setQuoteError("");
    if (!resourcesValid || !softwareValid) { setQuoteLoading(false); return; }
    const controller = new AbortController();
    setQuoteLoading(true);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/instances/quote", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ configuration: JSON.parse(configurationKey) }), signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to quote this configuration");
        if (!controller.signal.aborted) setQuoteResult({ key: configurationKey, value: data.quote });
      } catch (err) { if (!controller.signal.aborted) setQuoteError(err instanceof Error ? err.message : "Unable to quote this configuration"); }
      finally { if (!controller.signal.aborted) setQuoteLoading(false); }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [configurationKey, resourcesValid, softwareValid, token, quoteRevision]);

  const products = useMemo(() => {
    const available = options?.products.filter(product => entitlement.productId ? product.id === entitlement.productId : product.billingType !== "monthly" || product.id === initialProductId) || [];
    return available.sort((a, b) => Number(!!b.configurationPricing) - Number(!!a.configurationPricing));
  }, [options, entitlement.productId, initialProductId]);
  const groups = [...new Set(products.map(product => product.gpuFamily || product.name))];
  const product = options?.products.find(item => item.id === configuration.productId);
  const profile = capabilities?.profiles.find(item => item.id === configuration.instanceTypeId);
  const gpuShares = capabilities?.pools.find(pool => pool.id === configuration.poolId)?.gpuShares ?? [];
  const sharePercent = configuration.gpuSharePercent ?? 100;
  const gpuSummary = sharePercent < 100 ? ` · ${sharePercent}% share` : ` × ${configuration.gpuCount}`;
  const region = capabilities?.regions.find(item => item.id === configuration.regionId);
  const regionOptions = capabilityResult?.value.productId === configuration.productId ? capabilityResult.value.regions : [];
  const storage = configuration.storage;
  const insufficientFunds = !!quote && quote.rate.prepayCents > 0 && !!options && options.walletBalanceCents < quote.rate.prepayCents;
  const launchReady = !!quote && !quoteLoading && !launching && !funding && !!name.trim() && name.trim().length <= 128 && !insufficientFunds && reviewedFingerprint === quote.fingerprint;
  const update = (patch: Partial<LaunchConfiguration>) => { setConfiguration(current => ({ ...current, ...patch })); setError(""); };
  const go = (next: number) => { setStep(next); title.current?.focus(); };

  async function topUp(amount: number) {
    setFunding(true); setError("");
    if (!options && draftAccountId) {
      const pending: Draft = { version: 1, teamId: "", ownerAccountId: draftAccountId, categorySlug: initialCategorySlug, configuration: draftConfiguration(configuration), name, sshKeyIds, step, lockedProductId: entitlement.productId, stripeSubscriptionId: entitlement.subscriptionId, metadata };
      try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(pending)); } catch { /* Checkout can proceed without local storage. */ }
    }
    try {
      const response = await fetch("/api/account/wallet-topup", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ amount, launchProductId: configuration.productId || initialProductId || "resume" }) });
      const data = await response.json();
      if (!response.ok || !data.url) throw new Error(data.error || "Unable to start checkout");
      window.location.assign(data.url);
    } catch (err) { setError(err instanceof Error ? err.message : "Unable to start checkout"); setFunding(false); }
  }
  async function launch() {
    if (!launchReady || !quote) return;
    setLaunching(true); setError("");
    try {
      const response = await fetch("/api/instances", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ configuration, quoteFingerprint: quote.fingerprint, name: name.trim(), sshKeyIds, stripeSubscriptionId: entitlement.subscriptionId }) });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409) { setQuoteRevision(value => value + 1); setReviewedFingerprint(""); }
        throw new Error(data.error || "Launch was not accepted. Review your configuration and try again.");
      }
      try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* Storage may be disabled. */ }
      const instanceId = data.instance_id || data.instance?.id || data.instanceId;
      if (data.software_error || data.launch_warning) {
        setAccepted({ instanceId: instanceId ? String(instanceId) : undefined, warning: String(data.software_error || data.launch_warning), configurationSaved: data.configuration_saved !== false });
        title.current?.focus();
      } else {
        onSuccess({ name: name.trim(), poolName: product?.name || "GPU", instanceId: instanceId ? String(instanceId) : undefined });
        onClose();
      }
    } catch (err) { const message = err instanceof Error ? err.message : "Unable to launch GPU"; setError(message); onError?.(message); }
    finally { setLaunching(false); }
  }


  const pool = capabilities?.pools.find(item => item.id === configuration.poolId);
  const noCapacity = !!capabilities && (capabilities.serviceType === "pod_accelerator" ? !capabilities.pools.length : !capabilities.gpuModels.length);
  const rootDisk = capabilities?.rootStorageBlocks.find(item => item.id === configuration.rootStorageBlockId);
  const continueDisabled = !options || capabilityLoading || !capabilities || launching || funding || (step === 0 ? !configuration.productId || !configuration.regionId : step === 1 ? !resourcesValid : step === 2 ? !softwareValid || !quote || quoteLoading : !name.trim());
  const setGpuCount = (count: number) => { if (capabilities && Number.isInteger(count) && count >= 1 && count <= capabilities.maxGpuCount) update({ gpuCount: count, imageHash: "", instanceTypeId: "", rootStorageBlockId: "" }); };

  if (accepted) return <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(5,12,11,0.75)] p-5 backdrop-blur-sm">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="launch-title" className="w-full max-w-lg space-y-4 border border-[var(--line)] bg-[var(--ink-soft)] p-6 text-[var(--fg)]">
      <p className="label-mono text-[var(--warn)]">Needs attention</p>
      <h2 ref={title} id="launch-title" tabIndex={-1} className="text-xl font-semibold outline-none">GPU launch accepted</h2>
      <p className="text-sm text-[var(--fg-soft)]">Your GPU launch was accepted, but setup needs attention. Do not launch another GPU to retry this operation.</p>
      <p role="alert" className={ui.notice.warn}>{accepted.warning}</p>
      <p className="text-sm text-[var(--fg-muted)]">{accepted.configurationSaved ? "The instance and its accepted billing configuration have been saved. Check its details for status." : "Support must reconcile this instance and its payment before it can be managed safely."}</p>
      <button type="button" className={ui.primary} onClick={() => closeRef.current()}>View my GPU</button>
    </div>
  </div>;

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(5,12,11,0.75)] p-0 backdrop-blur-sm sm:p-5">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="launch-title" className="flex max-h-[100dvh] w-full max-w-6xl flex-col overflow-hidden border border-[var(--line)] bg-[var(--ink-soft)] text-[var(--fg)] sm:max-h-[92dvh]">
      <header className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-5 pb-5 pt-6 sm:px-8">
        <div className="min-w-0">
          <p className="label-mono text-[var(--acid)]">GPU workspace</p>
          <h2 ref={title} tabIndex={-1} id="launch-title" className="mt-2 text-2xl font-semibold outline-none">{deployContext?.title || "Launch GPU"}</h2>
          <p className="mt-1 text-sm text-[var(--fg-muted)]">Configure only what you need. Review the full price before launch.</p>
        </div>
        <button type="button" aria-label="Close GPU configurator" className="-mr-2 flex h-10 w-10 shrink-0 items-center justify-center text-[var(--fg-muted)] transition-colors hover:bg-[var(--ink-raise)] hover:text-[var(--fg)] disabled:opacity-40" onClick={onClose} disabled={launching || funding}>
          <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4"><path d="M3.5 3.5l9 9m0-9l-9 9" stroke="currentColor" strokeWidth="1.6" /></svg>
        </button>
      </header>
      <nav aria-label="Launch steps" className="shrink-0 overflow-x-auto border-b border-[var(--line)] px-5 sm:px-8">
        <ol className="flex min-w-max items-center gap-3 py-4">{steps.map((label, index) => {
          const done = index < step; const current = index === step;
          return <li key={label} className="flex items-center gap-3">
            {index > 0 && <span aria-hidden className={`h-px w-6 sm:w-10 ${done || current ? "bg-[var(--acid)]" : "bg-[var(--line)]"}`} />}
            <button type="button" aria-current={current ? "step" : undefined} disabled={index > step || launching || funding} onClick={() => go(index)} className={`flex items-center gap-2.5 text-sm transition-colors disabled:cursor-not-allowed ${current ? "font-semibold text-[var(--fg)]" : done ? "text-[var(--fg-soft)] hover:text-[var(--fg)]" : "text-[var(--fg-faint)]"}`}>
              <span className={`flex h-6 w-6 items-center justify-center font-mono text-xs font-bold ${current ? "bg-[var(--acid)] text-[var(--ink)]" : done ? "border border-[var(--acid)] text-[var(--acid)]" : "border border-[var(--line-strong)]"}`}>
                {done ? <svg aria-hidden viewBox="0 0 12 12" className="h-3 w-3"><path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg> : index + 1}
              </span>
              {label}
            </button>
          </li>;
        })}</ol>
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-8 p-5 sm:p-8 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section aria-label={steps[step]} className="min-w-0 space-y-6">
            {restored && <div className={ui.notice.info}>Your saved configuration has been restored and is being revalidated. Re-enter any Hugging Face token or custom script; secrets are not saved.</div>}
            {bootstrapError ? <div role="alert" className={ui.notice.danger}>{bootstrapError} <button type="button" className="ml-1 font-medium underline" onClick={() => setReload(value => value + 1)}>Retry</button></div> : !options ? <p role="status" className="text-sm text-[var(--fg-muted)]">Loading GPU offerings…</p> : <fieldset disabled={launching || funding} className="min-w-0 space-y-6">
              <legend className="sr-only">{steps[step]}</legend>
              <div>
                <h3 className="text-xl font-semibold">{steps[step]}</h3>
                {stepIntros[step] && <p className="mt-1 text-sm text-[var(--fg-muted)]">{stepIntros[step]}</p>}
              </div>
              {step === 0 && <>
                {entitlement.productId && <p className={ui.notice.info}>Monthly entitlement: your paid GPU and included allocation are locked. Persistent storage is separately charged.</p>}
                <fieldset className="space-y-4">
                  <legend className={ui.label}>GPU offering</legend>
                  {!products.length && <p className="text-sm text-[var(--fg-muted)]">No entitled GPU offerings are available for this account.</p>}
                  {groups.map(group => <div key={group} className="space-y-2">
                    {groups.length > 1 && <p className="text-xs font-semibold text-[var(--fg-soft)]">{group}</p>}
                    <div className="grid gap-3 sm:grid-cols-2">{products.filter(item => (item.gpuFamily || item.name) === group).map(item => {
                      const fractional = item.configurationPricing?.fractionalGpu === true && item.billingType !== "monthly";
                      return <ChoiceCard key={item.id} name="launch-product" checked={configuration.productId === item.id} disabled={!!entitlement.productId && item.id !== entitlement.productId}
                        onChange={() => update({ ...emptyConfiguration, productId: item.id, poolId: undefined, gpuModelId: undefined, software: configuration.software })}>
                        <span className="pr-6 text-base font-semibold">{item.name}</span>
                        <span className="text-xs text-[var(--fg-muted)]">{[item.vramGb != null ? `${item.vramGb} GB VRAM` : null, item.billingType === "monthly" ? "Monthly included" : item.configurationPricing ? "Pay per resource" : "Fixed bundle"].filter(Boolean).join(" · ")}</span>
                        <span className="mt-3 flex items-end justify-between gap-3">
                          <span className="tabular-nums">{item.billingType !== "monthly" && item.pricePerHourCents != null ? <><span className="text-lg font-semibold">{money(item.pricePerHourCents)}</span><span className="text-xs text-[var(--fg-muted)]"> / GPU-hour</span></> : <span className="text-xs text-[var(--fg-muted)]">Priced on review</span>}</span>
                          {fractional && <span className="label-mono border border-[var(--acid)] px-1.5 py-0.5 text-[10px] text-[var(--acid)]">Fractional</span>}
                        </span>
                      </ChoiceCard>;
                    })}</div>
                  </div>)}
                  {product && <p className="text-xs leading-relaxed text-[var(--fg-muted)]">{product.billingType === "monthly" ? "Your subscription covers its included allocation." : product.configurationPricing ? `The GPU rate is shown above. CPU, RAM and disk are added at their own rates${product.configurationPricing.fractionalGpu ? ", and you can rent part of a GPU on the next step" : ""}.` : "Only the original default bundle has a price; custom allocations need resource rates configured before launch."}</p>}
                </fieldset>
                <fieldset className="space-y-3">
                  <legend className={ui.label}>Region</legend>
                  {regionOptions.length ? <div className="grid gap-3 sm:grid-cols-3">{regionOptions.map(item => <ChoiceCard key={item.id} name="launch-region" checked={configuration.regionId === item.id}
                    onChange={() => update({ regionId: item.id, gpuCount: 0, gpuSharePercent: undefined, instanceTypeId: "", imageHash: "", rootStorageBlockId: "", poolId: undefined, gpuModelId: undefined, storage: { mode: "none" } })}>
                    <span className="pr-6 text-sm font-semibold">{item.name}</span>
                    {item.country && <span className="text-xs text-[var(--fg-muted)]">{item.country}</span>}
                  </ChoiceCard>)}</div> : <p className="text-sm text-[var(--fg-muted)]">{configuration.productId ? "Checking where this GPU is available…" : "Choose a GPU to see its regions."}</p>}
                </fieldset>
              </>}
              {step === 1 && capabilities && (noCapacity ? <div className="border border-dashed border-[var(--line-strong)] p-6">
                <p className="font-semibold">No {product?.name || "GPUs"} available in {region?.name || "this region"} right now</p>
                <p className="mt-1 text-sm text-[var(--fg-muted)]">Every GPU of this kind is in use or not offered here. Go back to pick another GPU or region, or try again shortly.</p>
                <div className="mt-4 flex flex-wrap gap-3"><button type="button" className={ui.secondary} onClick={() => go(0)}>Change GPU or region</button><button type="button" className={ui.secondary} onClick={() => setCapabilityRevision(value => value + 1)}>Check again</button></div>
              </div> : <>
                <div className="space-y-5 border border-[var(--line)] bg-[var(--ink)] p-5">
                  {capabilities.serviceType === "pod_accelerator" ? capabilities.pools.length > 1 && !capabilities.locks.pool ? <label className="block"><span className={ui.label}>GPU pool</span>
                    <Select value={configuration.poolId || ""} onChange={event => update({ poolId: Number(event.target.value), gpuCount: 0, gpuSharePercent: undefined, instanceTypeId: "", imageHash: "", rootStorageBlockId: "" })}>{capabilities.pools.map(item => <option key={item.id} value={item.id}>{item.name}{item.vramGb != null ? ` · ${item.vramGb} GB VRAM` : ""}</option>)}</Select>
                  </label> : <div><p className={ui.label}>GPU pool</p><p className="mt-2 text-sm font-medium">{pool?.name || "Provider default"}{pool?.vramGb != null ? <span className="text-[var(--fg-muted)]"> · {pool.vramGb} GB VRAM</span> : null}</p></div>
                    : <label className="block"><span className={ui.label}>GPU model</span>
                      <Select value={configuration.gpuModelId || ""} disabled={capabilities.locks.pool} onChange={event => update({ gpuModelId: event.target.value, gpuCount: 0, instanceTypeId: "", imageHash: "", rootStorageBlockId: "" })}>{capabilities.gpuModels.map(model => <option key={model.id} value={model.id}>{model.name}{model.vramGb != null ? ` · ${model.vramGb} GB VRAM` : ""}</option>)}</Select>
                    </label>}
                  {gpuShares.some(share => share.percent < 100) && <fieldset>
                    <legend className={ui.label}>GPU share</legend>
                    <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {gpuShares.map(share => {
                        const chosen = share.percent === sharePercent;
                        const soldOut = !share.maxGpuCount;
                        const gpuCents = product?.pricePerHourCents == null ? null : Math.round(product.pricePerHourCents * share.percent / 100);
                        return <ChoiceCard key={share.percent} name="launch-gpu-share" checked={chosen} disabled={soldOut} className="gap-2 p-3"
                          onChange={() => update({ gpuSharePercent: share.percent, gpuCount: 1, imageHash: "", instanceTypeId: "", rootStorageBlockId: "" })}>
                          <span className="font-mono text-xl font-bold tabular-nums">{share.percent}%</span>
                          <span aria-hidden className="h-1 w-full bg-[var(--line)]"><span className={`block h-full ${chosen ? "bg-[var(--acid)]" : "bg-[var(--fg-faint)]"}`} style={{ width: `${share.percent}%` }} /></span>
                          <span className="text-xs text-[var(--fg-soft)]">{shareNames[share.percent] ?? "Guaranteed share"}</span>
                          <span className="text-xs font-medium tabular-nums">{soldOut ? "Sold out" : gpuCents == null ? " " : `${money(gpuCents)} / hr`}</span>
                        </ChoiceCard>;
                      })}
                    </div>
                    <p className={ui.hint}>A share guarantees that fraction of one GPU&apos;s compute time, billed at the same fraction of the GPU rate.</p>
                  </fieldset>}
                  {sharePercent === 100 && <div>
                    <label htmlFor="launch-gpu-count" className={ui.label}>Whole GPUs</label>
                    <div className="mt-2 flex w-fit items-stretch border border-[var(--line)] bg-[var(--ink-sink)]">
                      <button type="button" aria-label="One fewer GPU" className="w-10 text-lg text-[var(--fg-soft)] hover:bg-[var(--ink-raise)] disabled:opacity-30" disabled={capabilities.locks.gpuCount || configuration.gpuCount <= 1} onClick={() => setGpuCount(configuration.gpuCount - 1)}>−</button>
                      <input id="launch-gpu-count" className="w-16 border-x border-[var(--line)] bg-transparent py-2 text-center font-mono text-sm tabular-nums text-[var(--fg)] focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" type="number" min={1} max={capabilities.maxGpuCount} step={1} value={configuration.gpuCount} disabled={capabilities.locks.gpuCount} onChange={event => setGpuCount(Number(event.target.value))} />
                      <button type="button" aria-label="One more GPU" className="w-10 text-lg text-[var(--fg-soft)] hover:bg-[var(--ink-raise)] disabled:opacity-30" disabled={capabilities.locks.gpuCount || configuration.gpuCount >= capabilities.maxGpuCount} onClick={() => setGpuCount(configuration.gpuCount + 1)}>+</button>
                    </div>
                    <span className={ui.hint}>{capabilities.locks.gpuCount ? "Fixed by your plan." : `Up to ${capabilities.maxGpuCount} whole GPU${capabilities.maxGpuCount === 1 ? "" : "s"} for this selection.`}</span>
                  </div>}
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                  <label className="block sm:col-span-2"><span className={ui.label}>CPU & RAM profile {capabilities.locks.profile && <span className="text-[var(--fg-faint)]">{product?.billingType === "monthly" ? "· monthly included" : "· provider locked"}</span>}</span>
                    <Select value={configuration.instanceTypeId} disabled={capabilities.locks.profile} onChange={event => update({ instanceTypeId: event.target.value, rootStorageBlockId: "" })}>{capabilities.profiles.map(item => <option key={item.id} value={item.id}>{item.cpuCores} CPU cores · {item.ramGb} GB RAM · {item.name}</option>)}</Select>
                  </label>
                  <label className="block"><span className={ui.label}>System image {capabilities.locks.image && <span className="text-[var(--fg-faint)]">· provider locked</span>}</span>
                    <Select value={configuration.imageHash} disabled={capabilities.locks.image} onChange={event => update({ imageHash: event.target.value, instanceTypeId: "", rootStorageBlockId: "" })}>{capabilities.images.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>
                  </label>
                  <label className="block"><span className={ui.label}>Root disk {capabilities.locks.rootStorage && <span className="text-[var(--fg-faint)]">{product?.billingType === "monthly" ? "· monthly included" : "· provider locked"}</span>}</span>
                    <Select value={configuration.rootStorageBlockId} disabled={capabilities.locks.rootStorage} onChange={event => update({ rootStorageBlockId: event.target.value })}>{capabilities.rootStorageBlocks.map(item => <option key={item.id} value={item.id}>{item.sizeGb} GB · {item.name}</option>)}</Select>
                  </label>
                </div>
                {pool?.rootfsEnabled === false && <p className={ui.notice.warn}>This pool does not keep root-disk files across restarts. Put anything you need to keep on persistent storage.</p>}
                <fieldset className="space-y-3">
                  <legend className={ui.label}>Persistent storage</legend>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <ChoiceCard name="launch-storage" checked={storage.mode === "none"} onChange={() => update({ storage: { mode: "none" } })}><span className="pr-6 text-sm font-semibold">None</span><span className="text-xs text-[var(--fg-muted)]">Root disk only</span></ChoiceCard>
                    <ChoiceCard name="launch-storage" checked={storage.mode === "new"} disabled={!capabilities.sharedStorageBlocks.length} onChange={() => update({ storage: { mode: "new", blockId: capabilities.sharedStorageBlocks[0]?.id || "" } })}><span className="pr-6 text-sm font-semibold">New volume</span><span className="text-xs text-[var(--fg-muted)]">Survives stop and delete</span></ChoiceCard>
                    <ChoiceCard name="launch-storage" checked={storage.mode === "existing"} disabled={!capabilities.volumes.length} onChange={() => update({ storage: { mode: "existing", volumeId: capabilities.volumes[0]?.id || 0 } })}><span className="pr-6 text-sm font-semibold">Existing volume</span><span className="text-xs text-[var(--fg-muted)]">{capabilities.volumes.length ? `${capabilities.volumes.length} available` : "None yet"}</span></ChoiceCard>
                  </div>
                  {capabilities.sharedStorageUnavailable && <p className="text-xs text-[var(--fg-muted)]">Persistent storage is not available in this region right now. You can still launch without it.</p>}
                  {storage.mode === "new" && <label className="block"><span className={ui.label}>Volume size</span><Select value={storage.blockId} onChange={event => update({ storage: { mode: "new", blockId: event.target.value } })}>{capabilities.sharedStorageBlocks.map(item => <option key={item.id} value={item.id}>{item.sizeGb} GB · {item.name}</option>)}</Select></label>}
                  {storage.mode === "existing" && <label className="block"><span className={ui.label}>Volume</span><Select value={storage.volumeId} onChange={event => update({ storage: { mode: "existing", volumeId: Number(event.target.value) } })}>{capabilities.volumes.filter(volume => volume.regionId === configuration.regionId).map(item => <option key={item.id} value={item.id}>{item.name} · {item.sizeGb} GB</option>)}</Select></label>}
                  <p className="text-xs leading-relaxed text-[var(--fg-muted)]">Persistent volumes are billed separately for as long as they exist, including while the GPU is stopped or after it is deleted. Attaching an existing volume does not charge for a second copy.</p>
                </fieldset>
              </>)}
              {step === 2 && <LaunchSoftwarePicker token={token} value={configuration.software} onChange={software => update({ software })} selected={metadata} onSelect={setMetadata} />}
              {step === 3 && <>
                <label className="block"><span className={ui.label}>Instance name</span><input className={ui.field} required maxLength={128} value={name} onChange={event => setName(event.target.value)} autoComplete="off" placeholder="training-workspace" /></label>
                <fieldset className="space-y-3"><legend className={ui.label}>SSH keys <span className="text-[var(--fg-faint)]">· optional</span></legend>{options.sshKeys.length ? <div className="grid gap-3 sm:grid-cols-2">{options.sshKeys.map(key => <ChoiceCard key={key.id} type="checkbox" name="launch-ssh-keys" checked={sshKeyIds.includes(key.id)} onChange={checked => setSshKeyIds(current => checked ? [...current, key.id] : current.filter(id => id !== key.id))}><span className="pr-6 text-sm font-semibold">{key.name}</span><span className="break-all font-mono text-[11px] text-[var(--fg-muted)]">{key.fingerprint}</span></ChoiceCard>)}</div> : <p className="text-sm text-[var(--fg-muted)]">No SSH keys saved. Add a key in Dashboard settings before launch if you need SSH access.</p>}</fieldset>
              </>}
              {step === 4 && <>
                <div className="border border-[var(--line)] bg-[var(--ink)] p-5">
                  <p className="text-lg font-semibold">{name || "Name required"}</p>
                  <p className="mt-1 text-sm text-[var(--fg-soft)]">{product?.name} · {region?.name} · {sharePercent < 100 ? `${sharePercent}% GPU share` : `${configuration.gpuCount} GPU${configuration.gpuCount === 1 ? "" : "s"}`}</p>
                  <p className="mt-1 text-sm text-[var(--fg-muted)]">{configuration.software.kind === "huggingface" ? configuration.software.hfItemId : configuration.software.kind === "recipe" ? `Managed recipe: ${metadata?.id === configuration.software.appId ? metadata.name : configuration.software.appId}` : configuration.software.kind === "startup" ? "Startup script" : "No additional software"} · {sshKeyIds.length} SSH key{sshKeyIds.length === 1 ? "" : "s"}</p>
                </div>
                {quote && <>
                  <div className="overflow-x-auto border border-[var(--line)]"><table className="w-full text-left text-sm"><caption className="sr-only">Itemized hourly quote</caption>
                    <thead className="bg-[var(--ink-sink)]"><tr><th className="label-mono px-4 py-3">Resource</th><th className="label-mono px-4 py-3 text-right">Per hour</th></tr></thead>
                    <tbody>{quote.rate.lines.map(line => <tr key={line.key} className="border-t border-[var(--line)]"><td className="px-4 py-3">{line.label}<span className="block text-xs text-[var(--fg-muted)]">{line.quantity} {line.unit}{line.separatelyMetered ? " · separately metered" : ""}</span></td><td className="px-4 py-3 text-right font-mono tabular-nums">{money(line.hourlyCents)}</td></tr>)}</tbody>
                    <tfoot className="border-t border-[var(--line-strong)] bg-[var(--ink-sink)] font-semibold"><tr><td className="px-4 py-3">Total ongoing hourly cost</td><td className="px-4 py-3 text-right font-mono tabular-nums text-[var(--acid)]">{money(quote.rate.totalHourlyCents)}</td></tr></tfoot>
                  </table></div>
                  <div className="space-y-2 text-sm text-[var(--fg-muted)]"><p>Due at launch: <strong className="text-[var(--fg)]">{money(quote.rate.prepayCents)}</strong>. Minimum billing period: {quote.rate.minimumBillingMinutes} minutes.</p><p>Stopped instance: {money(quote.rate.stoppedInstanceHourlyCents)}/hour. Persistent storage: {money(quote.rate.sharedStorageHourlyCents)}/hour, separately metered while the volume exists.</p>{product?.billingType === "monthly" && <p>GPU and included resources are paid by your monthly subscription; persistent storage is not included.</p>}</div>
                  {quote.warnings.map(warning => <p key={warning} className={ui.notice.warn}>{warning}</p>)}
                  <ChoiceCard type="checkbox" name="launch-reviewed" checked={reviewedFingerprint === quote.fingerprint} onChange={checked => setReviewedFingerprint(checked ? quote.fingerprint : "")}><span className="pr-6 text-sm">I have reviewed this configuration, {money(quote.rate.totalHourlyCents)}/hour total and {money(quote.rate.prepayCents)} due at launch. If the quote changes, I will review it again.</span></ChoiceCard>
                </>}
              </>}
            </fieldset>}
            {capabilityLoading && <p role="status" className="flex items-center gap-2 text-sm text-[var(--fg-muted)]"><span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--line-strong)] border-t-[var(--acid)] motion-reduce:animate-none" />Checking supported regions and resources…</p>}
            {capabilityError && <div role="alert" className={`${ui.notice.danger} space-y-2`}><p>{capabilityError}</p><p className="flex flex-wrap gap-4"><button type="button" className="font-medium underline" onClick={() => setCapabilityRevision(value => value + 1)}>Retry capabilities</button><button type="button" className="font-medium underline" onClick={() => update({ gpuCount: 0, gpuSharePercent: undefined, poolId: undefined, gpuModelId: undefined, imageHash: "", instanceTypeId: "", rootStorageBlockId: "" })}>Reload provider defaults</button></p></div>}
            {quoteError && <div role="alert" className={ui.notice.danger}>{quoteError}<p className="mt-1">Change the resources or software, or <button type="button" className="font-medium underline" onClick={() => setQuoteRevision(value => value + 1)}>retry quote</button>.</p></div>}
            {error && <p role="alert" className={ui.notice.danger}>{error}</p>}
            {(insufficientFunds || bootstrapError.toLowerCase().includes("no team")) && <div className={`${ui.notice.warn} space-y-3`}><h4 className="font-semibold">Add funds to continue</h4><p className="text-[var(--fg-soft)]">Your non-secret configuration is saved for your return from checkout. {options && `Wallet: ${money(options.walletBalanceCents)}.`}</p><div className="flex flex-wrap gap-2">{amounts.map(amount => <button key={amount.value} type="button" disabled={funding || launching} className={ui.secondary} onClick={() => void topUp(amount.value)}>{funding ? "Opening checkout…" : `Add ${amount.label}`}</button>)}</div>{!amounts.length && <p className="text-[var(--fg-soft)]">Top-up options are unavailable. Try again or use Dashboard billing.</p>}</div>}
          </section>
          <aside aria-label="Live configuration summary" className="h-fit border border-[var(--line)] bg-[var(--ink)] lg:sticky lg:top-0">
            <h3 className="border-b border-[var(--line)] px-5 py-4"><span className="label-mono">Your configuration</span></h3>
            <dl className="space-y-4 px-5 py-5 text-sm">
              <div><dt className="label-mono text-[10px] text-[var(--fg-faint)]">GPU</dt><dd className="mt-1 font-semibold">{product?.name || "Choose a GPU"}{product && configuration.gpuCount > 0 && <span className="font-normal text-[var(--fg-soft)]">{gpuSummary}</span>}</dd></div>
              <div><dt className="label-mono text-[10px] text-[var(--fg-faint)]">Region</dt><dd className="mt-1">{region?.name || <span className="text-[var(--fg-muted)]">Not chosen yet</span>}</dd></div>
              <div><dt className="label-mono text-[10px] text-[var(--fg-faint)]">CPU / RAM</dt><dd className="mt-1">{profile ? `${profile.cpuCores} cores / ${profile.ramGb} GB` : <span className="text-[var(--fg-muted)]">Not chosen yet</span>}</dd></div>
              <div><dt className="label-mono text-[10px] text-[var(--fg-faint)]">Root disk</dt><dd className="mt-1">{rootDisk ? `${rootDisk.sizeGb} GB` : <span className="text-[var(--fg-muted)]">Not chosen yet</span>}</dd></div>
              <div><dt className="label-mono text-[10px] text-[var(--fg-faint)]">Persistent storage</dt><dd className="mt-1">{storage.mode === "none" ? "None" : storage.mode === "new" ? `${capabilities?.sharedStorageBlocks.find(item => item.id === storage.blockId)?.sizeGb ?? "-"} GB · new volume` : `${capabilities?.volumes.find(item => item.id === storage.volumeId)?.sizeGb ?? "-"} GB · existing volume`}</dd></div>
            </dl>
            <div className="border-t border-[var(--line)] px-5 py-5" aria-live="polite">
              {quoteLoading ? <p className="text-sm text-[var(--fg-muted)]">Updating quote…</p> : quote ? <>
                <p className="font-mono text-3xl font-bold tracking-tight tabular-nums">{money(quote.rate.totalHourlyCents)}<span className="font-sans text-sm font-normal text-[var(--fg-muted)]"> / hour</span></p>
                <p className="mt-2 text-xs text-[var(--fg-muted)]">Instance {money(quote.rate.instanceHourlyCents)} + storage {money(quote.rate.sharedStorageHourlyCents)}</p>
                <p className="mt-3 text-sm"><span className="text-[var(--fg-muted)]">Due at launch</span> <strong className="font-mono">{money(quote.rate.prepayCents)}</strong></p>
              </> : <p className="text-sm leading-relaxed text-[var(--fg-muted)]">Your live price appears here once the resources are chosen. No estimates or fallback prices.</p>}
            </div>
          </aside>
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--line)] bg-[var(--ink)] px-5 py-4 sm:px-8">
        <button type="button" className={ui.secondary} disabled={launching || funding} onClick={() => step ? go(step - 1) : onClose()}>{step ? "Back" : "Cancel"}</button>
        <span className="label-mono hidden text-[var(--fg-faint)] sm:block">Step {step + 1} of {steps.length}</span>
        {step < 4 ? <button type="button" className={ui.primary} disabled={continueDisabled} onClick={() => go(step + 1)}>Continue</button>
          : <button type="button" className={ui.primary} disabled={!launchReady} onClick={() => void launch()}>{launching ? "Submitting launch…" : "Launch GPU"}</button>}
      </footer>
    </div>
  </div>;
}
