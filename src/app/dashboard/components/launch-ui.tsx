import type { ReactNode, SelectHTMLAttributes } from "react";

/** Shared look for the Launch GPU wizard: ink surfaces, hairlines, and the acid accent for choices. */
export const ui = {
  label: "label-mono block",
  hint: "mt-2 block text-xs font-normal leading-relaxed text-[var(--fg-muted)]",
  field: "mt-2 w-full appearance-none border border-[var(--line)] bg-[var(--ink-sink)] px-3 py-2.5 text-sm text-[var(--fg)] transition-colors hover:border-[var(--line-strong)] focus:border-[var(--acid)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-60",
  primary: "inline-flex items-center justify-center gap-2 bg-[var(--acid)] px-5 py-2.5 text-sm font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--acid-deep)] disabled:cursor-not-allowed disabled:opacity-40",
  secondary: "inline-flex items-center justify-center gap-2 border border-[var(--line)] px-4 py-2.5 text-sm font-medium text-[var(--fg)] transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--ink-raise)] disabled:cursor-not-allowed disabled:opacity-40",
  notice: {
    info: "border border-[var(--ok-line)] bg-[var(--ok-fill)] p-3 text-sm text-[var(--fg-soft)]",
    warn: "border border-[var(--warn-line)] bg-[var(--warn-fill)] p-3 text-sm text-[var(--warn)]",
    danger: "border border-[var(--danger-line)] bg-[var(--danger-fill)] p-3 text-sm text-[var(--danger)]",
  },
};

/** A native select with a chevron that matches the ink field, since the platform arrow sits flush against the border. */
export function Select({ className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <span className="relative block">
    <select {...props} className={`${ui.field} pr-10 ${className}`}>{children}</select>
    <svg aria-hidden viewBox="0 0 16 16" className="pointer-events-none absolute right-3 top-1/2 mt-1 h-4 w-4 -translate-y-1/2 text-[var(--fg-muted)]"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
  </span>;
}

/**
 * A selectable card backed by a real radio or checkbox input, so arrow keys, form semantics
 * and screen readers behave natively while the card carries the visual state.
 */
export function ChoiceCard({ type = "radio", name, checked, disabled, onChange, children, className = "" }: {
  type?: "radio" | "checkbox"; name: string; checked: boolean; disabled?: boolean;
  onChange: (checked: boolean) => void; children: ReactNode; className?: string;
}) {
  return <label className={`group relative flex cursor-pointer flex-col gap-1 border p-4 text-left transition-colors has-focus-visible:outline has-focus-visible:outline-3 has-focus-visible:outline-[var(--fg)] has-disabled:cursor-not-allowed has-disabled:opacity-45 ${checked ? "border-[var(--acid)] bg-[rgba(200,255,61,0.06)] shadow-[inset_0_0_0_1px_var(--acid)]" : "border-[var(--line)] bg-[var(--ink-sink)] hover:border-[var(--line-strong)] hover:bg-[var(--ink-raise)]"} ${className}`}>
    <input type={type} name={name} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} className="sr-only" />
    <span aria-hidden className={`absolute right-3 top-3 flex h-4 w-4 items-center justify-center border ${type === "radio" ? "rounded-full" : ""} ${checked ? "border-[var(--acid)] bg-[var(--acid)]" : "border-[var(--line-strong)]"}`}>
      {checked && <svg viewBox="0 0 12 12" className="h-2.5 w-2.5 text-[var(--ink)]"><path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>}
    </span>
    {children}
  </label>;
}
