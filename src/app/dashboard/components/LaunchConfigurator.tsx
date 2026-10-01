"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { launchConfigurationSchema, type ConfigurationPricing, type LaunchCapabilities, type LaunchConfiguration, type LaunchQuote } from "@/lib/launch-config";
import { LaunchSoftwarePicker, type SoftwareSelectionMetadata } from "./LaunchSoftwarePicker";

interface LaunchProduct {
  id: string; name: string; gpuFamily: string | null; billingType: string;
  configurationPricing?: ConfigurationPricing | null; vramGb: number | null;
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
const emptyConfiguration: LaunchConfiguration = { productId: "", regionId: 0, instanceTypeId: "", imageHash: "", rootStorageBlockId: "", gpuCount: 0, storage: { mode: "none" }, software: { kind: "none" } };
const field = "mt-1 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2.5 text-sm text-zinc-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20 disabled:bg-zinc-100 disabled:text-zinc-600";
const button = "rounded-xl border border-zinc-200 px-4 py-2.5 text-sm font-medium hover:border-teal-500 disabled:cursor-not-allowed disabled:opacity-50";
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 });
const money = (cents: number) => usd.format(cents / 100);
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
  const capKey = [configuration.productId, configuration.regionId, configuration.poolId || "", configuration.gpuModelId || "", configuration.gpuCount, configuration.imageHash, configuration.instanceTypeId].join(":");
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

  if (accepted) return <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/60 p-5">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="launch-title" className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-6 text-zinc-900 shadow-2xl">
      <h2 ref={title} id="launch-title" tabIndex={-1} className="text-xl font-semibold">GPU launch accepted</h2>
      <p>Your GPU launch was accepted, but setup needs attention. Do not launch another GPU to retry this operation.</p>
      <p role="alert" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">{accepted.warning}</p>
      <p className="text-sm text-zinc-600">{accepted.configurationSaved ? "The instance and its accepted billing configuration have been saved. Check its details for status." : "Support must reconcile this instance and its payment before it can be managed safely."}</p>
      <button type="button" className={`${button} bg-teal-700 text-white`} onClick={() => closeRef.current()}>View my GPU</button>
    </div>
  </div>;

  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/60 p-0 backdrop-blur-sm sm:p-5">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="launch-title" className="flex max-h-[100dvh] w-full max-w-6xl flex-col overflow-hidden bg-white text-zinc-900 shadow-2xl sm:max-h-[92dvh] sm:rounded-2xl">
      <header className="flex items-start justify-between border-b border-zinc-200 px-5 py-4 sm:px-7">
        <div><p className="text-xs font-semibold uppercase tracking-widest text-teal-700">GPU workspace</p><h2 ref={title} tabIndex={-1} id="launch-title" className="mt-1 text-xl font-semibold outline-none">{deployContext?.title || "Launch GPU"}</h2><p className="mt-1 text-sm text-zinc-500">Configure only what you need. Review the full price before launch.</p></div>
        <button type="button" aria-label="Close GPU configurator" className={button} onClick={onClose} disabled={launching || funding}>Close</button>
      </header>
      <nav aria-label="Launch steps" className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-200 px-4 py-3 sm:px-7">{steps.map((label, index) => <button key={label} type="button" aria-current={step === index ? "step" : undefined} disabled={index > step || launching || funding} onClick={() => go(index)} className={`whitespace-nowrap rounded-lg px-3 py-2 text-xs font-medium disabled:cursor-not-allowed ${step === index ? "bg-teal-700 text-white" : "text-zinc-500 hover:bg-zinc-100"}`}>{index + 1}. {label}</button>)}</nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-6 p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section aria-label={steps[step]} className="min-w-0 space-y-5">
            {restored && <div className="rounded-xl bg-teal-50 p-3 text-sm text-teal-900">Your saved configuration has been restored and is being revalidated. Re-enter any Hugging Face token or custom script; secrets are not saved.</div>}
            {bootstrapError ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{bootstrapError}<button type="button" className="ml-2 underline" onClick={() => setReload(value => value + 1)}>Retry</button></div> : !options ? <p role="status">Loading GPU offerings…</p> : <fieldset disabled={launching || funding} className="min-w-0 space-y-5">
              <legend className="sr-only">{steps[step]}</legend>
              <h3 className="text-lg font-semibold">{steps[step]}</h3>
              {step === 0 && <>
                {entitlement.productId && <p className="rounded-xl bg-teal-50 p-3 text-sm text-teal-900">Monthly entitlement: your paid GPU and included allocation are locked. Persistent storage is separately charged.</p>}
                <label className="block text-sm font-medium">GPU offering
                  <select className={field} value={configuration.productId} disabled={!!entitlement.productId} onChange={event => update({ ...emptyConfiguration, productId: event.target.value, poolId: undefined, gpuModelId: undefined, software: configuration.software })}>
                    <option value="">Select a GPU</option>{groups.map(group => <optgroup key={group} label={group}>{products.filter(item => (item.gpuFamily || item.name) === group).map(item => <option value={item.id} key={item.id}>{item.name}{item.billingType === "monthly" ? " · Monthly included" : item.configurationPricing ? " · Resource rates available" : " · Default bundle pricing"}{item.vramGb != null ? ` · ${item.vramGb} GB VRAM` : ""}</option>)}</optgroup>)}
                  </select>
                </label>
                {!products.length && <p className="text-sm text-zinc-600">No entitled GPU offerings are available for this account.</p>}
                {product && <p className="text-sm text-zinc-500">{product.billingType === "monthly" ? "Your subscription covers its included allocation." : product.configurationPricing ? "Choose supported CPU/RAM and storage. Your selections determine the allocation and its resource charges." : "Choose supported CPU/RAM and storage. Only the original default bundle has a price; custom allocations need resource rates configured before launch."}</p>}
                <label className="block text-sm font-medium">Region
                  <select className={field} value={configuration.regionId || ""} disabled={!regionOptions.length || capabilityLoading} onChange={event => update({ regionId: Number(event.target.value), gpuCount: 0, instanceTypeId: "", imageHash: "", rootStorageBlockId: "", poolId: undefined, gpuModelId: undefined, storage: { mode: "none" } })}>
                    <option value="">Select a region</option>{regionOptions.map(item => <option key={item.id} value={item.id}>{item.name}{item.country ? ` · ${item.country}` : ""}</option>)}
                  </select>
                </label>
              </>}
              {step === 1 && capabilities && <>
                {capabilities.serviceType === "pod_accelerator" ? <label className="block text-sm font-medium">GPU pool
                  <select className={field} value={configuration.poolId || ""} disabled={capabilities.locks.pool} onChange={event => update({ poolId: Number(event.target.value), gpuCount: 0, instanceTypeId: "", imageHash: "", rootStorageBlockId: "" })}>{capabilities.pools.map(pool => <option key={pool.id} value={pool.id}>{pool.name}{pool.vramGb != null ? ` · ${pool.vramGb} GB VRAM` : ""}</option>)}</select>
                </label> : <label className="block text-sm font-medium">GPU model
                  <select className={field} value={configuration.gpuModelId || ""} disabled={capabilities.locks.pool} onChange={event => update({ gpuModelId: event.target.value, gpuCount: 0, instanceTypeId: "", imageHash: "", rootStorageBlockId: "" })}>{capabilities.gpuModels.map(model => <option key={model.id} value={model.id}>{model.name}{model.vramGb != null ? ` · ${model.vramGb} GB VRAM` : ""}</option>)}</select>
                </label>}
                <label className="block text-sm font-medium">Whole GPUs
                  <input className={field} type="number" min={1} max={capabilities.maxGpuCount} step={1} value={configuration.gpuCount} disabled={capabilities.locks.gpuCount} onChange={event => { const count = Number(event.target.value); if (Number.isInteger(count) && count >= 1 && count <= capabilities.maxGpuCount) update({ gpuCount: count, imageHash: "", instanceTypeId: "", rootStorageBlockId: "" }); }} />
                  <span className="mt-1 block text-xs font-normal text-zinc-500">Up to {capabilities.maxGpuCount} whole GPUs for this selection. Fractional shares are not offered.</span>
                </label>
                <label className="block text-sm font-medium">CPU & RAM profile {capabilities.locks.profile && (product?.billingType === "monthly" ? "· monthly included" : "· provider locked")}
                  <select className={field} value={configuration.instanceTypeId} disabled={capabilities.locks.profile} onChange={event => update({ instanceTypeId: event.target.value, rootStorageBlockId: "" })}>{capabilities.profiles.map(item => <option key={item.id} value={item.id}>{item.cpuCores} CPU cores · {item.ramGb} GB RAM · {item.name}</option>)}</select>
                </label>
                <label className="block text-sm font-medium">System image
                  <select className={field} value={configuration.imageHash} disabled={capabilities.locks.image} onChange={event => update({ imageHash: event.target.value, instanceTypeId: "", rootStorageBlockId: "" })}>{capabilities.images.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
                </label>
                <label className="block text-sm font-medium">Root disk {capabilities.locks.rootStorage && (product?.billingType === "monthly" ? "· monthly included" : "· provider locked")}
                  <select className={field} value={configuration.rootStorageBlockId} disabled={capabilities.locks.rootStorage} onChange={event => update({ rootStorageBlockId: event.target.value })}>{capabilities.rootStorageBlocks.map(item => <option key={item.id} value={item.id}>{item.sizeGb} GB · {item.name}</option>)}</select>
                </label>
                {capabilities.pools.find(pool => pool.id === configuration.poolId)?.rootfsEnabled === false && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">This pool does not support root-filesystem persistence. Do not rely on root-disk files surviving restarts.</p>}
                <label className="block text-sm font-medium">Persistent shared storage
                  <select className={field} value={configuration.storage.mode} onChange={event => update({ storage: event.target.value === "new" ? { mode: "new", blockId: capabilities.sharedStorageBlocks[0]?.id || "" } : event.target.value === "existing" ? { mode: "existing", volumeId: capabilities.volumes[0]?.id || 0 } : { mode: "none" } })}>
                    <option value="none">No persistent storage</option><option value="new" disabled={!capabilities.sharedStorageBlocks.length}>Create a new volume</option><option value="existing" disabled={!capabilities.volumes.length}>Attach an existing volume</option>
                  </select>
                </label>
                {configuration.storage.mode === "new" && <label className="block text-sm font-medium">New volume size<select className={field} value={configuration.storage.blockId} onChange={event => update({ storage: { mode: "new", blockId: event.target.value } })}>{capabilities.sharedStorageBlocks.map(item => <option key={item.id} value={item.id}>{item.sizeGb} GB · {item.name}</option>)}</select></label>}
                {configuration.storage.mode === "existing" && <label className="block text-sm font-medium">Existing volume<select className={field} value={configuration.storage.volumeId} onChange={event => update({ storage: { mode: "existing", volumeId: Number(event.target.value) } })}>{capabilities.volumes.filter(volume => volume.regionId === configuration.regionId).map(item => <option key={item.id} value={item.id}>{item.name} · {item.sizeGb} GB</option>)}</select></label>}
                <p className="text-xs text-zinc-500">Root storage belongs to this instance. Shared storage is billed separately and continues to incur charges while the volume exists, including when the GPU is stopped or deleted. Attaching an existing volume does not charge for a second copy.</p>
              </>}
              {step === 2 && <LaunchSoftwarePicker token={token} value={configuration.software} onChange={software => update({ software })} selected={metadata} onSelect={setMetadata} />}
              {step === 3 && <>
                <label className="block text-sm font-medium">Instance name<input className={field} required maxLength={128} value={name} onChange={event => setName(event.target.value)} autoComplete="off" placeholder="training-workspace" /></label>
                <fieldset className="space-y-3"><legend className="mb-2 text-sm font-medium">SSH keys (optional)</legend>{options.sshKeys.length ? options.sshKeys.map(key => <label key={key.id} className="flex items-start gap-3 rounded-xl border border-zinc-200 p-3 text-sm"><input className="mt-1" type="checkbox" checked={sshKeyIds.includes(key.id)} onChange={event => setSshKeyIds(current => event.target.checked ? [...current, key.id] : current.filter(id => id !== key.id))} /><span>{key.name}<span className="block break-all text-xs text-zinc-500">{key.fingerprint}</span></span></label>) : <p className="text-sm text-zinc-500">No SSH keys saved. Add a key in Dashboard settings before launch if you need SSH access.</p>}</fieldset>
              </>}
              {step === 4 && <>
                <div className="rounded-xl border border-zinc-200 p-4 text-sm"><p className="font-semibold">{name || "Name required"}</p><p className="mt-1 text-zinc-600">{product?.name} · {region?.name} · {configuration.gpuCount} GPU{configuration.gpuCount === 1 ? "" : "s"}</p><p className="mt-1 text-zinc-600">{configuration.software.kind === "huggingface" ? configuration.software.hfItemId : configuration.software.kind === "recipe" ? `Managed recipe: ${metadata?.id === configuration.software.appId ? metadata.name : configuration.software.appId}` : configuration.software.kind === "startup" ? "Startup script" : "No additional software"} · {sshKeyIds.length} SSH key{sshKeyIds.length === 1 ? "" : "s"}</p></div>
                {quote && <><div className="overflow-hidden rounded-xl border border-zinc-200"><table className="w-full text-left text-sm"><caption className="sr-only">Itemized hourly quote</caption><thead className="bg-zinc-50 text-xs text-zinc-500"><tr><th className="px-3 py-3">Resource</th><th className="px-3 py-3 text-right">Hourly price</th></tr></thead><tbody>{quote.rate.lines.map(line => <tr key={line.key} className="border-t border-zinc-100"><td className="px-3 py-3">{line.label}<span className="block text-xs text-zinc-500">{line.quantity} {line.unit}{line.separatelyMetered ? " · separately metered" : ""}</span></td><td className="px-3 py-3 text-right tabular-nums">{money(line.hourlyCents)}</td></tr>)}</tbody><tfoot className="border-t border-zinc-200 font-semibold"><tr><td className="px-3 py-3">Total ongoing hourly cost</td><td className="px-3 py-3 text-right">{money(quote.rate.totalHourlyCents)}</td></tr></tfoot></table></div>
                  <div className="space-y-2 text-sm text-zinc-600"><p>Due at launch: <strong>{money(quote.rate.prepayCents)}</strong>. Minimum billing period: {quote.rate.minimumBillingMinutes} minutes.</p><p>Stopped instance: {money(quote.rate.stoppedInstanceHourlyCents)}/hour. Shared storage: {money(quote.rate.sharedStorageHourlyCents)}/hour, separately metered while the volume exists.</p>{product?.billingType === "monthly" && <p>GPU and included resources are paid by your monthly subscription; shared storage is not included.</p>}</div>
                  {quote.warnings.map(warning => <p key={warning} className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{warning}</p>)}
                  <label className="flex items-start gap-3 rounded-xl border border-teal-200 bg-teal-50 p-4 text-sm"><input type="checkbox" className="mt-0.5" checked={reviewedFingerprint === quote.fingerprint} onChange={event => setReviewedFingerprint(event.target.checked ? quote.fingerprint : "")} /><span>I have reviewed this configuration, {money(quote.rate.totalHourlyCents)}/hour total and {money(quote.rate.prepayCents)} due at launch. If the quote changes, I will review it again.</span></label>
                </>}
              </>}
            </fieldset>}
            {capabilityLoading && <p role="status" className="text-sm text-zinc-500">Checking supported regions and resources…</p>}
            {capabilityError && <div role="alert" className="space-y-2 rounded-xl bg-red-50 p-3 text-sm text-red-700"><p>{capabilityError}</p><button type="button" className="mr-3 underline" onClick={() => setCapabilityRevision(value => value + 1)}>Retry capabilities</button><button type="button" className="underline" onClick={() => update({ gpuCount: 0, poolId: undefined, gpuModelId: undefined, imageHash: "", instanceTypeId: "", rootStorageBlockId: "" })}>Reload provider defaults</button></div>}
            {quoteError && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{quoteError}<p className="mt-1">Change the resources or software, or <button type="button" className="underline" onClick={() => setQuoteRevision(value => value + 1)}>retry quote</button>.</p></div>}
            {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
            {(insufficientFunds || bootstrapError.toLowerCase().includes("no team")) && <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4"><h4 className="font-medium">Add funds to continue</h4><p className="text-sm text-zinc-600">Your non-secret configuration is saved for your return from checkout. {options && `Wallet: ${money(options.walletBalanceCents)}.`}</p><div className="flex flex-wrap gap-2">{amounts.map(amount => <button key={amount.value} type="button" disabled={funding || launching} className={button} onClick={() => void topUp(amount.value)}>{funding ? "Opening checkout…" : `Add ${amount.label}`}</button>)}</div>{!amounts.length && <p className="text-sm">Top-up options are unavailable. Try again or use Dashboard billing.</p>}</div>}
          </section>
          <aside aria-label="Live configuration summary" className="h-fit rounded-2xl border border-zinc-200 bg-zinc-50 p-5 lg:sticky lg:top-0">
            <h3 className="font-semibold">Your configuration</h3>
            <dl className="mt-4 space-y-3 text-sm">
              <div><dt className="text-zinc-500">GPU</dt><dd className="font-medium">{product?.name || "Choose a GPU"}{product && ` × ${configuration.gpuCount}`}</dd></div>
              <div><dt className="text-zinc-500">Region</dt><dd>{region?.name || "Checking availability"}</dd></div>
              <div><dt className="text-zinc-500">CPU / RAM</dt><dd>{profile ? `${profile.cpuCores} cores / ${profile.ramGb} GB` : "Choose supported resources"}</dd></div>
              <div><dt className="text-zinc-500">Root disk</dt><dd>{capabilities?.rootStorageBlocks.find(item => item.id === configuration.rootStorageBlockId)?.sizeGb ?? "—"} GB</dd></div>
              <div><dt className="text-zinc-500">Shared storage</dt><dd>{storage.mode === "none" ? "None" : storage.mode === "new" ? `${capabilities?.sharedStorageBlocks.find(item => item.id === storage.blockId)?.sizeGb ?? "—"} GB · new volume` : `${capabilities?.volumes.find(item => item.id === storage.volumeId)?.sizeGb ?? "—"} GB · existing volume`}</dd></div>
            </dl>
            <div className="mt-5 border-t border-zinc-200 pt-4" aria-live="polite">
              {quoteLoading ? <p className="text-sm text-zinc-500">Updating quote…</p> : quote ? <>
                <p className="text-2xl font-semibold tracking-tight">{money(quote.rate.totalHourlyCents)}<span className="text-sm font-normal text-zinc-500"> / hour</span></p>
                <p className="mt-1 text-xs text-zinc-500">Instance {money(quote.rate.instanceHourlyCents)} + shared storage {money(quote.rate.sharedStorageHourlyCents)}</p>
                <p className="mt-2 text-sm">{money(quote.rate.prepayCents)} due at launch</p>
              </> : <p className="text-sm text-zinc-500">Complete valid resource and software selections for a live quote. No estimated or fallback prices.</p>}
            </div>
          </aside>
        </div>
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-zinc-200 bg-white px-5 py-4 sm:px-7"><button type="button" className={button} disabled={launching || funding} onClick={() => step ? go(step - 1) : onClose()}>{step ? "Back" : "Cancel"}</button><span className="hidden text-xs text-zinc-500 sm:block">Step {step + 1} of {steps.length}</span>{step < 4 ? <button type="button" className={`${button} border-teal-700 bg-teal-700 text-white hover:bg-teal-800`} disabled={!options || capabilityLoading || !capabilities || launching || funding || (step === 0 ? !configuration.productId || !configuration.regionId : step === 1 ? !resourcesValid : step === 2 ? !softwareValid || !quote || quoteLoading : !name.trim())} onClick={() => go(step + 1)}>Continue</button> : <button type="button" className={`${button} border-teal-700 bg-teal-700 text-white hover:bg-teal-800`} disabled={!launchReady} onClick={() => void launch()}>{launching ? "Submitting launch…" : "Launch GPU"}</button>}</footer>
    </div>
  </div>;
}
