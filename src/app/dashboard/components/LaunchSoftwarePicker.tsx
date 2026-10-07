"use client";

import { useEffect, useState } from "react";
import type { LaunchSoftware } from "@/lib/launch-config";
import { STARTUP_SCRIPT_PRESETS } from "@/lib/startup-scripts";
import type { LaunchModelSupport } from "@/lib/launch-model-runtime";
import { ChoiceCard, Select, ui } from "./launch-ui";

export interface SoftwareSelectionMetadata {
  id: string;
  name: string;
  description?: string;
  gated?: boolean | string;
  vramGb?: number;
  compatibility?: { message: string; status: string };
  launchSupport?: LaunchModelSupport;
}
interface Recipe { id: string; name: string; description: string; canDeploy?: boolean; deployable?: boolean }
const kinds = [
  { kind: "none", name: "Clean image", detail: "Just the system image" },
  { kind: "huggingface", name: "Hugging Face model", detail: "Served with vLLM" },
  { kind: "recipe", name: "Managed app", detail: "One-click recipes" },
  { kind: "startup", name: "Startup script", detail: "Runs after boot" },
] as const;

export function LaunchSoftwarePicker({ token, value, onChange, selected, onSelect }: {
  token: string;
  value: LaunchSoftware;
  onChange: (value: LaunchSoftware) => void;
  selected: SoftwareSelectionMetadata | null;
  onSelect: (value: SoftwareSelectionMetadata) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SoftwareSelectionMetadata[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (value.kind !== "huggingface" && value.kind !== "recipe") return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(async () => {
      try {
        const url = value.kind === "recipe" ? "/api/apps" : query.trim().length >= 2
          ? `/api/huggingface/search?${new URLSearchParams({ q: query.trim(), type: "model", limit: "20" })}`
          : "/api/huggingface/catalog?type=model&launch=true";
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load software catalog");
        if (controller.signal.aborted) return;
        if (value.kind === "recipe") setRecipes((data.apps || []).filter((app: Recipe) => app.deployable && app.canDeploy));
        else setItems(data.results || data.items || []);
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "Unable to load software catalog");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, query ? 350 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [token, value.kind, query, retry]);

  return <div className="space-y-5">
    <p className="text-sm text-[var(--fg-muted)]">Start with a clean image or add software. Compatibility is checked against your exact GPU and resources before launch.</p>
    <fieldset>
      <legend className={ui.label}>Software</legend>
      <div className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-4">{kinds.map(item => <ChoiceCard key={item.kind} name="launch-software" checked={value.kind === item.kind} onChange={() => {
        if (item.kind === "huggingface") onChange({ kind: item.kind, hfItemId: "", openWebUI: false, netdata: false });
        else if (item.kind === "recipe") onChange({ kind: item.kind, appId: "" });
        else if (item.kind === "startup") onChange({ kind: item.kind });
        else onChange({ kind: "none" });
      }}><span className="pr-6 text-sm font-semibold">{item.name}</span><span className="text-xs text-[var(--fg-muted)]">{item.detail}</span></ChoiceCard>)}</div>
    </fieldset>
    {value.kind === "huggingface" && <>
      <label className={ui.label}>Search Hugging Face models
        <input className={ui.field} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search model name or organization" type="search" />
      </label>
      <p className="text-xs text-[var(--fg-muted)]">Model launch uses float16 vLLM. Unsupported featured models cannot be selected. Unverified models, including search results and gated models, require a compatibility check before launch.</p>
      {value.hfItemId && <div className="border border-[var(--acid)] bg-[rgba(200,255,61,0.06)] p-3 text-sm"><strong>{selected?.id === value.hfItemId ? selected.name : value.hfItemId}</strong><p className="break-all text-xs text-[var(--fg-muted)]">{value.hfItemId}</p>{selected?.id === value.hfItemId && selected.description && <p className="mt-1 text-[var(--fg-muted)]">{selected.description}</p>}</div>}
      {!loading && !error && items.length === 0 && <p className="text-sm text-[var(--fg-muted)]">No models found. Try another search.</p>}
      <div className="max-h-56 space-y-2 overflow-y-auto" aria-label="Model results">
        {!loading && items.map(item => <button type="button" key={item.id} disabled={item.launchSupport?.status === "unsupported"} aria-pressed={value.hfItemId === item.id} className={`w-full border p-3 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${value.hfItemId === item.id ? "border-[var(--acid)] bg-[rgba(200,255,61,0.06)]" : "border-[var(--line)] bg-[var(--ink-sink)] enabled:hover:border-[var(--line-strong)]"}`} onClick={() => { onSelect(item); onChange({ kind: "huggingface", hfItemId: item.id, openWebUI: value.openWebUI, netdata: value.netdata }); }}>
          <span className="block font-medium">{item.name || item.id}</span><span className="block break-all text-xs text-[var(--fg-muted)]">{item.id}</span>
          {item.launchSupport?.status === "supported" && item.vramGb != null && item.vramGb > 0 && <span className="block text-xs text-[var(--fg-muted)]">Estimated float16 VRAM: {item.vramGb} GB</span>}
          <span className={`block text-xs ${item.launchSupport?.status === "unsupported" ? "text-[var(--danger)]" : "text-[var(--fg-muted)]"}`}>{item.launchSupport?.message || "Runtime compatibility unverified. Model access and float16 resource requirements will be checked before launch."}</span>
        </button>)}
      </div>
      <label className={ui.label}>Hugging Face access token {selected?.id === value.hfItemId && selected.gated ? "(required for gated model)" : "(optional for public models)"}
        <input className={ui.field} type="password" autoComplete="off" value={value.hfToken || ""} onChange={event => onChange({ ...value, hfToken: event.target.value })} placeholder="hf_…" />
        <span className={ui.hint}>Required for gated/private models. Accept the model license first. Tokens are never saved in the launch draft.</span>
      </label>
      <label className="flex items-center gap-2 text-sm accent-[var(--acid)]"><input type="checkbox" checked={value.openWebUI || false} onChange={event => onChange({ ...value, openWebUI: event.target.checked })} /> Add Open WebUI</label>
      <label className="flex items-center gap-2 text-sm accent-[var(--acid)]"><input type="checkbox" checked={value.netdata || false} onChange={event => onChange({ ...value, netdata: event.target.checked })} /> Add Netdata monitoring</label>
    </>}
    {value.kind === "recipe" && <>
      <label className={ui.label}>Deployable managed recipe
        <Select value={value.appId} onChange={event => {
          const recipe = recipes.find(item => item.id === event.target.value);
          onChange({ kind: "recipe", appId: event.target.value });
          if (recipe) onSelect({ id: recipe.id, name: recipe.name, description: recipe.description });
        }} disabled={loading}>
          <option value="">Select an app recipe</option>{recipes.map(recipe => <option key={recipe.id} value={recipe.id}>{recipe.name}</option>)}
        </Select>
      </label>
      {!loading && !error && !recipes.length && <p className="text-sm text-[var(--fg-muted)]">No active deployable recipes are available for this account.</p>}
      <p className="text-sm text-[var(--fg-muted)]">{recipes.find(recipe => recipe.id === value.appId)?.description}</p>
    </>}
    {value.kind === "startup" && <>
      <label className={ui.label}>Startup script
        <Select value={value.presetId || "custom"} onChange={event => onChange(event.target.value === "custom" ? { kind: "startup", script: "" } : { kind: "startup", presetId: event.target.value })}>
          <option value="custom">Custom script</option>{STARTUP_SCRIPT_PRESETS.map(preset => <option value={preset.id} key={preset.id}>{preset.name}</option>)}
        </Select>
      </label>
      {value.presetId ? <p className="text-sm text-[var(--fg-muted)]">{STARTUP_SCRIPT_PRESETS.find(preset => preset.id === value.presetId)?.description}</p> : <label className={ui.label}>Custom startup script
        <textarea className={`${ui.field} min-h-48 font-mono`} maxLength={65536} value={value.script || ""} onChange={event => onChange({ kind: "startup", script: event.target.value })} spellCheck={false} placeholder="#!/bin/bash" />
        <span className={ui.hint}>Runs after provisioning. Custom scripts are never saved; re-enter after checkout or reopening this wizard.</span>
      </label>}
    </>}
    {loading && <p role="status" className="text-sm text-[var(--fg-muted)]">Loading software catalog…</p>}
    {error && <div role="alert" className={ui.notice.danger}>{error} <button type="button" className="underline" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
  </div>;
}
