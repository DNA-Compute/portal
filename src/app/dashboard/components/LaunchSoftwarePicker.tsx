"use client";

import { useEffect, useState } from "react";
import type { LaunchSoftware } from "@/lib/launch-config";
import { STARTUP_SCRIPT_PRESETS } from "@/lib/startup-scripts";
import type { LaunchModelSupport } from "@/lib/launch-model-runtime";

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
const field = "mt-1 w-full rounded-xl border border-[var(--line)] bg-white px-3 py-2.5 text-sm text-zinc-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20";

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
    <p className="text-sm text-zinc-600">Start with a clean image or add software. Compatibility is checked against your exact GPU and resources before launch.</p>
    <label className="block text-sm font-medium">Software
      <select className={field} value={value.kind} onChange={event => {
        const kind = event.target.value;
        if (kind === "huggingface") onChange({ kind, hfItemId: "", openWebUI: false, netdata: false });
        else if (kind === "recipe") onChange({ kind, appId: "" });
        else if (kind === "startup") onChange({ kind });
        else onChange({ kind: "none" });
      }}>
        <option value="none">No additional software</option><option value="huggingface">Hugging Face model</option><option value="recipe">Managed app recipe</option><option value="startup">Startup script</option>
      </select>
    </label>
    {value.kind === "huggingface" && <>
      <label className="block text-sm font-medium">Search Hugging Face models
        <input className={field} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search model name or organization" type="search" />
      </label>
      <p className="text-xs text-zinc-600">Model launch uses float16 vLLM. Unsupported featured models cannot be selected. Unverified models, including search results and gated models, require a compatibility check before launch.</p>
      {value.hfItemId && <div className="rounded-xl border border-teal-200 bg-teal-50 p-3 text-sm"><strong>{selected?.id === value.hfItemId ? selected.name : value.hfItemId}</strong><p className="break-all text-xs text-zinc-600">{value.hfItemId}</p>{selected?.id === value.hfItemId && selected.description && <p className="mt-1 text-zinc-600">{selected.description}</p>}</div>}
      {!loading && !error && items.length === 0 && <p className="text-sm text-zinc-600">No models found. Try another search.</p>}
      <div className="max-h-56 space-y-2 overflow-y-auto" aria-label="Model results">
        {!loading && items.map(item => <button type="button" key={item.id} disabled={item.launchSupport?.status === "unsupported"} aria-pressed={value.hfItemId === item.id} className={`w-full rounded-xl border p-3 text-left text-sm disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500 ${value.hfItemId === item.id ? "border-teal-600 bg-teal-50" : "border-zinc-200 enabled:hover:border-teal-500"}`} onClick={() => { onSelect(item); onChange({ kind: "huggingface", hfItemId: item.id, openWebUI: value.openWebUI, netdata: value.netdata }); }}>
          <span className="block font-medium">{item.name || item.id}</span><span className="block break-all text-xs text-zinc-500">{item.id}</span>
          {item.launchSupport?.status === "supported" && item.vramGb != null && item.vramGb > 0 && <span className="block text-xs text-zinc-600">Estimated float16 VRAM: {item.vramGb} GB</span>}
          <span className={`block text-xs ${item.launchSupport?.status === "unsupported" ? "text-red-700" : "text-zinc-600"}`}>{item.launchSupport?.message || "Runtime compatibility unverified. Model access and float16 resource requirements will be checked before launch."}</span>
        </button>)}
      </div>
      <label className="block text-sm font-medium">Hugging Face access token {selected?.id === value.hfItemId && selected.gated ? "(required for gated model)" : "(optional for public models)"}
        <input className={field} type="password" autoComplete="off" value={value.hfToken || ""} onChange={event => onChange({ ...value, hfToken: event.target.value })} placeholder="hf_…" />
        <span className="mt-1 block text-xs font-normal text-zinc-500">Required for gated/private models. Accept the model license first. Tokens are never saved in the launch draft.</span>
      </label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={value.openWebUI || false} onChange={event => onChange({ ...value, openWebUI: event.target.checked })} /> Add Open WebUI</label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={value.netdata || false} onChange={event => onChange({ ...value, netdata: event.target.checked })} /> Add Netdata monitoring</label>
    </>}
    {value.kind === "recipe" && <>
      <label className="block text-sm font-medium">Deployable managed recipe
        <select className={field} value={value.appId} onChange={event => {
          const recipe = recipes.find(item => item.id === event.target.value);
          onChange({ kind: "recipe", appId: event.target.value });
          if (recipe) onSelect({ id: recipe.id, name: recipe.name, description: recipe.description });
        }} disabled={loading}>
          <option value="">Select an app recipe</option>{recipes.map(recipe => <option key={recipe.id} value={recipe.id}>{recipe.name}</option>)}
        </select>
      </label>
      {!loading && !error && !recipes.length && <p className="text-sm text-zinc-600">No active deployable recipes are available for this account.</p>}
      <p className="text-sm text-zinc-600">{recipes.find(recipe => recipe.id === value.appId)?.description}</p>
    </>}
    {value.kind === "startup" && <>
      <label className="block text-sm font-medium">Startup script
        <select className={field} value={value.presetId || "custom"} onChange={event => onChange(event.target.value === "custom" ? { kind: "startup", script: "" } : { kind: "startup", presetId: event.target.value })}>
          <option value="custom">Custom script</option>{STARTUP_SCRIPT_PRESETS.map(preset => <option value={preset.id} key={preset.id}>{preset.name}</option>)}
        </select>
      </label>
      {value.presetId ? <p className="text-sm text-zinc-600">{STARTUP_SCRIPT_PRESETS.find(preset => preset.id === value.presetId)?.description}</p> : <label className="block text-sm font-medium">Custom startup script
        <textarea className={`${field} min-h-48 font-mono`} maxLength={65536} value={value.script || ""} onChange={event => onChange({ kind: "startup", script: event.target.value })} spellCheck={false} placeholder="#!/bin/bash" />
        <span className="mt-1 block text-xs font-normal text-zinc-500">Runs after provisioning. Custom scripts are never saved; re-enter after checkout or reopening this wizard.</span>
      </label>}
    </>}
    {loading && <p role="status" className="text-sm text-zinc-500">Loading software catalog…</p>}
    {error && <div role="alert" className="text-sm text-red-700">{error} <button type="button" className="underline" onClick={() => setRetry(value => value + 1)}>Try again</button></div>}
  </div>;
}
