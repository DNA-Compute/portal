import type { Metadata } from "next";
import Link from "next/link";
import { DocsTab } from "@/app/dashboard/components/DocsTab";
import { getBrandName } from "@/lib/branding";

/**
 * The documentation the sidebar has always linked to.
 *
 * DocsTab carries fourteen sections and was written upstream, but nothing in
 * this fork ever rendered it and no /docs route existed, so the "Docs" item in
 * the dashboard sidebar - which hardcodes `${getAppUrl()}/docs` and opens in a
 * new tab - had been sending customers to a 404 since the fork was created.
 *
 * Public rather than session-gated. These are product docs: how to pick a card,
 * deploy a model, attach storage, reach a pod over SSH. Someone deciding whether
 * to sign up has more use for them than someone already signed in, and none of
 * it is account data. The API Reference pane is the one part not shown, because
 * it loads its spec from /api/openapi and that endpoint does not exist here.
 */
export const metadata: Metadata = {
  title: "Documentation",
  description:
    "Deploy models, attach persistent storage, reach your pod over SSH, and understand billing on the DNA Compute GPU cloud.",
};

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-[var(--ink)]">
      <header className="sticky top-0 z-50 border-b border-[var(--line)] bg-[var(--panel-veil)] backdrop-blur-md">
        <div className="mx-auto flex h-[var(--header-height)] max-w-5xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-3 no-underline">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/dna-compute-logo.png" alt={getBrandName()} className="h-11 w-auto" />
          </Link>
          <Link
            href="/account"
            className="font-mono text-xs font-bold uppercase tracking-[0.1em] text-[var(--acid)] no-underline hover:text-[var(--fg)]"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-12">
        <p className="label-mono mb-5">Documentation</p>
        <h1 className="mb-3 text-[length:var(--heading-section)] font-[540] leading-[1.05] tracking-[var(--track-section)] text-[var(--fg)]">
          {getBrandName()} docs
        </h1>
        <p className="mb-10 max-w-[52ch] text-[length:var(--copy-card)] leading-relaxed text-[var(--fg-muted)]">
          Deploying a model, attaching storage, reaching a pod over SSH, and how
          billing works.
        </p>

        <DocsTab />
      </main>
    </div>
  );
}
