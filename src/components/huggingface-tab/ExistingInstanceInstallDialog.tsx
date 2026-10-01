"use client";

import { useEffect, useRef, useState } from "react";
import type { CatalogItem, SearchResult } from "./types";
import { isChatModel } from "./helpers";

interface Props {
  token: string;
  item: CatalogItem | SearchResult;
  onClose: () => void;
  onInstallationStarted?: () => void;
}

interface RunningInstance {
  id: string;
  name: string;
  gpuCount: number;
  gpuModel?: string;
}

interface InstanceListResponse {
  error?: string;
  poolSubscriptions?: Array<{
    id: string;
    status?: string;
    pool_name?: string;
    pool_label?: string;
    per_pod_info?: { vgpu_count?: number; image_name?: string };
  }>;
  podMetadata?: Record<string, { displayName?: string | null; gpuCount?: number }>;
}

interface InstallationResponse {
  success?: boolean;
  error?: string;
  requiresToken?: boolean;
  installing?: boolean;
  message?: string;
  instructions?: string;
  logs?: string;
}

const button = "rounded-xl border border-zinc-200 px-4 py-2.5 text-sm font-medium hover:border-teal-500 disabled:cursor-not-allowed disabled:opacity-50";
const field = "mt-1 w-full rounded-xl border border-zinc-200 bg-white px-3 py-2.5 text-sm text-zinc-900 focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20 disabled:bg-zinc-100";

// Parents mount a fresh session for each account/model and unmount it on close.
// The Hugging Face token is intentionally never persisted in browser storage.
export function ExistingInstanceInstallDialog({ token, item, onClose, onInstallationStarted }: Props) {
  const [instances, setInstances] = useState<RunningInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [instanceId, setInstanceId] = useState("");
  const [hfToken, setHfToken] = useState("");
  const [requiresToken, setRequiresToken] = useState(Boolean(item.gated));
  const [openWebUI, setOpenWebUI] = useState(false);
  const [netdata, setNetdata] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState("");
  const [accepted, setAccepted] = useState<InstallationResponse | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const busy = useRef(false);
  const close = useRef(onClose);
  close.current = () => {
    if (busy.current) return;
    setHfToken("");
    onClose();
    if (accepted) onInstallationStarted?.();
  };

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    title.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
      if (event.key !== "Tab") return;
      const targets = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]') || []).filter(element => element.getClientRects().length && !element.closest("fieldset:disabled"));
      const first = targets[0];
      const last = targets[targets.length - 1];
      if (!first) { event.preventDefault(); title.current?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === title.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError("");
    setInstances([]);
    setInstanceId("");
    async function load() {
      try {
        const response = await fetch("/api/instances", {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        const data: InstanceListResponse = await response.json();
        if (!response.ok) throw new Error(data.error || "Unable to load existing GPUs");
        if (!Array.isArray(data.poolSubscriptions)) throw new Error("The instance list was incomplete. Please retry.");
        const running = data.poolSubscriptions.flatMap(instance => {
          const metadata = data.podMetadata?.[instance.id];
          const gpuCount = metadata?.gpuCount ?? instance.per_pod_info?.vgpu_count ?? 0;
          if (instance.status?.toLowerCase() !== "running" || !instance.id || !Number.isInteger(gpuCount) || gpuCount < 1) return [];
          return [{
            id: String(instance.id),
            name: metadata?.displayName || instance.pool_label || instance.pool_name || String(instance.id),
            gpuCount,
            gpuModel: instance.per_pod_info?.image_name,
          }];
        });
        if (!controller.signal.aborted) setInstances(running);
      } catch (err) {
        if (!controller.signal.aborted) setLoadError(err instanceof Error ? err.message : "Unable to load existing GPUs");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [token, revision]);

  const selected = instances.find(instance => instance.id === instanceId);
  const canSubmit = Boolean(token && selected && !loading && !loadError && !submitting && !accepted && (!requiresToken || hfToken.trim()));

  async function install() {
    if (!canSubmit || busy.current) return;
    busy.current = true;
    setSubmitting(true);
    setError("");
    setLogs("");
    try {
      const response = await fetch("/api/huggingface/deploy-existing", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          hfItemId: item.id,
          subscriptionId: instanceId,
          hfToken: hfToken.trim() || undefined,
          openWebUI,
          netdata,
        }),
      });
      const data: InstallationResponse = await response.json();
      setLogs(data.logs || "");
      if (!response.ok || data.success !== true) {
        if (data.requiresToken) setRequiresToken(true);
        throw new Error(data.error || "Installation was not accepted. Check the instance and try again.");
      }
      setHfToken("");
      setAccepted(data);
      title.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to start installation");
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/60 p-4 backdrop-blur-sm">
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="existing-install-title" aria-busy={submitting} className="max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white text-zinc-900 shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-zinc-200 p-5">
          <div>
            <h2 ref={title} id="existing-install-title" tabIndex={-1} className="text-xl font-semibold outline-none">{accepted ? "Installation accepted" : "Install on existing GPU"}</h2>
            <p className="mt-1 break-words text-sm text-zinc-600">{item.name}</p>
          </div>
          <button type="button" className={button} aria-label="Close existing GPU installation" disabled={submitting} onClick={() => close.current()}>Close</button>
        </header>
        <div className="space-y-5 p-5">
          {accepted ? (
            <div role="status" className="space-y-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
              <h3 className="font-semibold">{accepted.installing ? "Installing in the background" : "Model server starting"}</h3>
              {accepted.message && <p>{accepted.message}</p>}
              <p>The model is not confirmed ready. Installation and model loading may take several minutes. You can close this dialog while setup continues and check your GPU details for status.</p>
              {accepted.instructions && <p className="break-words font-mono text-xs">{accepted.instructions}</p>}
            </div>
          ) : (
            <>
              <p className="text-sm text-zinc-600">Use a running GPU in your current account. This does not create a GPU or take a new compute payment; your existing GPU billing continues.</p>
              {loading ? <p role="status">Loading running GPUs…</p> : loadError ? (
                <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                  <p>{loadError}</p>
                  <button type="button" className={`${button} mt-3`} onClick={() => setRevision(value => value + 1)}>Retry loading GPUs</button>
                </div>
              ) : !instances.length ? (
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm">
                  <p>No running GPUs are available in this account. Start an existing GPU from My GPUs, then refresh. To create one, close this dialog and choose Launch new GPU.</p>
                  <button type="button" className={`${button} mt-3`} onClick={() => setRevision(value => value + 1)}>Refresh GPUs</button>
                </div>
              ) : (
                <fieldset disabled={submitting} className="space-y-4">
                  <legend className="sr-only">Existing GPU installation options</legend>
                  <label className="block text-sm font-medium">Running GPU
                    <select className={field} value={instanceId} onChange={event => setInstanceId(event.target.value)}>
                      <option value="">Select a running GPU</option>
                      {instances.map(instance => <option key={instance.id} value={instance.id}>{instance.name} · {instance.gpuCount} GPU{instance.gpuCount === 1 ? "" : "s"}{instance.gpuModel ? ` · ${instance.gpuModel}` : ""}</option>)}
                    </select>
                  </label>
                  <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Installing replaces the existing model workload on the selected GPU. Make sure its GPU memory and storage can accommodate this model.</p>
                  <label className="block text-sm font-medium">Hugging Face token {requiresToken ? "(required)" : "(optional)"}
                    <input type="password" autoComplete="off" spellCheck={false} value={hfToken} onChange={event => setHfToken(event.target.value)} placeholder="hf_…" required={requiresToken} className={field} />
                    <span className="mt-1 block text-xs font-normal text-zinc-500">For gated or private models, use a token with access to the model. It is cleared when this dialog closes and is not saved in your browser.</span>
                  </label>
                  {isChatModel(item) && <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={openWebUI} onChange={event => setOpenWebUI(event.target.checked)} />Add Chat UI (Open WebUI)</label>}
                  <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={netdata} onChange={event => setNetdata(event.target.checked)} />Enable Netdata monitoring</label>
                </fieldset>
              )}
              {submitting && <p role="status" className="rounded-xl bg-blue-50 p-4 text-sm text-blue-900">Starting installation on your existing GPU. Please keep this dialog open while the request is being accepted.</p>}
            </>
          )}
          {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>}
          {logs && <details className="text-sm"><summary className="cursor-pointer font-medium">Installation logs</summary><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-100 p-3 text-xs">{logs}</pre></details>}
          <footer className="flex justify-end gap-3">
            <button type="button" className={button} disabled={submitting} onClick={() => close.current()}>{accepted ? "Done" : "Cancel"}</button>
            {!accepted && <button type="button" className={`${button} bg-teal-700 text-white hover:bg-teal-800`} disabled={!canSubmit} onClick={() => void install()}>{submitting ? "Starting installation…" : "Install model"}</button>}
          </footer>
        </div>
      </div>
    </div>
  );
}
