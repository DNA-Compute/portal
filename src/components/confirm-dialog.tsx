"use client";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** "danger" for an action that loses data or stops billing-relevant work. */
  tone?: "default" | "danger";
}

interface Pending extends ConfirmOptions {
  resolve: (confirmed: boolean) => void;
}

/**
 * An in-page replacement for window.confirm: `if (!(await confirm({...}))) return;`.
 * Render `dialog` once in the component. Unlike the native dialog it matches the portal,
 * and it does not block the page's scripts while it is open.
 */
export function useConfirmDialog() {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    []
  );

  const close = useCallback((confirmed: boolean) => {
    setPending((current) => {
      current?.resolve(confirmed);
      return null;
    });
  }, []);

  const dialog = pending ? <ConfirmDialog {...pending} onClose={close} /> : null;
  return { confirm, dialog };
}

function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "default",
  onClose,
}: ConfirmOptions & { onClose: (confirmed: boolean) => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => onClose(false)}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="bg-white rounded-2xl shadow-xl max-w-md w-full border border-[var(--line)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="px-6 pt-5 pb-4">
          <h2 id="confirm-dialog-title" className="text-base font-medium text-[var(--fg)]">{title}</h2>
          <div className="mt-2 text-sm text-[var(--muted)] space-y-2">{message}</div>
        </div>
        <div className="border-t border-[var(--line)] px-6 py-4 flex justify-end gap-3">
          <button type="button" onClick={() => onClose(false)} className="px-4 py-2 text-sm font-medium text-zinc-600 hover:text-[var(--fg)] transition-colors">
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => onClose(true)}
            className={`px-4 py-2.5 text-sm font-medium rounded-xl text-white transition-colors ${
              tone === "danger" ? "bg-rose-600 hover:bg-rose-700" : "bg-teal-500 hover:bg-teal-600"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
