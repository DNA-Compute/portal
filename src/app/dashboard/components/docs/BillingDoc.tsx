"use client";

export function BillingDoc() {
  return (
    <div className="prose prose-zinc max-w-none">
      <h1>Billing &amp; Usage Guide</h1>
      <p className="lead">
        This platform offers two ways to rent GPUs: pay-as-you-go with a prepaid wallet, or a flat-rate monthly subscription.
      </p>

      {/* Table of Contents */}
      <nav className="not-prose my-8 p-4 bg-zinc-50 dark:bg-zinc-50 rounded-lg border border-zinc-200 dark:border-zinc-200">
        <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-800 mb-3">On this page</h4>
        <ul className="space-y-1.5 text-sm">
          <li><a href="#two-billing-models" className="text-blue-600 dark:text-blue-400 hover:underline">Two Ways to Rent a GPU</a></li>
          <li><a href="#hourly-wallet" className="text-blue-600 dark:text-blue-400 hover:underline">Hourly (Pay-as-you-go)</a></li>
          <li><a href="#monthly-subscription" className="text-blue-600 dark:text-blue-400 hover:underline">Monthly Subscription</a></li>
          <li><a href="#gpu-pricing" className="text-blue-600 dark:text-blue-400 hover:underline">GPU Pricing</a></li>
          <li><a href="#how-wallet-works" className="text-blue-600 dark:text-blue-400 hover:underline">How the Wallet Works</a></li>
          <li><a href="#storage-pricing" className="text-blue-600 dark:text-blue-400 hover:underline">Storage Pricing</a></li>
          <li><a href="#cost-management" className="text-blue-600 dark:text-blue-400 hover:underline">Cost Management Tips</a></li>
          <li><a href="#faq" className="text-blue-600 dark:text-blue-400 hover:underline">FAQ</a></li>
        </ul>
      </nav>

      {/* ── Two Billing Models ─────────────────────────────────── */}

      <h2 id="two-billing-models">Two Ways to Rent a GPU</h2>
      <p>
        Every GPU on this platform is available through one of two billing models.
        Choose the one that fits your workload:
      </p>

      <div className="not-prose grid gap-4 sm:grid-cols-2 my-6">
        <div className="p-5 rounded-xl border border-zinc-200 dark:border-zinc-200 bg-zinc-50 dark:bg-zinc-50">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">Option 1</p>
          <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-800 mb-2">Hourly (Wallet)</h3>
          <ul className="text-sm text-zinc-600 dark:text-zinc-400 space-y-2 list-disc list-inside">
            <li>Top up your wallet, deploy GPUs on demand</li>
            <li>Pay only for what you use</li>
            <li>Billed in 30-minute intervals</li>
            <li>Unused time in a billing window is credited back</li>
            <li>No commitment &mdash; terminate anytime</li>
          </ul>
        </div>
        <div className="p-5 rounded-xl border border-teal-200 dark:border-teal-800 bg-teal-50 dark:bg-teal-900/20">
          <p className="text-xs font-semibold uppercase tracking-wider text-teal-600 mb-2">Option 2</p>
          <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-800 mb-2">Monthly Subscription</h3>
          <ul className="text-sm text-zinc-600 dark:text-zinc-400 space-y-2 list-disc list-inside">
            <li>A flat monthly rate for one dedicated GPU</li>
            <li>Paid via credit card (Stripe subscription)</li>
            <li>Completely independent of your wallet balance</li>
            <li>Renews automatically each month</li>
            <li>Cancel anytime from your account</li>
          </ul>
        </div>
      </div>

      {/* ── Hourly / Wallet ────────────────────────────────────── */}

      <h2 id="hourly-wallet">Hourly (Pay-as-you-go)</h2>
      <p>
        The hourly model is designed for on-demand workloads. You add funds to your
        wallet and deploy GPUs whenever you need them. Billing works in <strong>30-minute
        intervals</strong>:
      </p>
      <ol>
        <li><strong>Deploy a GPU</strong> &mdash; 30 minutes of usage is pre-charged from your wallet.</li>
        <li><strong>Every 30 minutes</strong> &mdash; usage is recalculated and the next interval is deducted.</li>
        <li><strong>Terminate early</strong> &mdash; if you stop before the 30-minute window ends, the unused portion is credited back to your wallet.</li>
      </ol>

      <div className="not-prose bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4 my-6">
        <h4 className="text-green-800 dark:text-green-200 font-semibold mb-2 text-base">Example</h4>
        <p className="text-green-700 dark:text-green-300 text-sm mb-0">
          You launch an instance at $3.00/hr (an example rate). After 45 minutes you terminate it.
          You&apos;re charged for two 30-minute intervals ($1.50 each = $3.00 total), but
          the 15 unused minutes from the second interval are credited back ($0.75).
          Net cost: <strong>$2.25</strong> for 45 minutes of GPU time.
        </p>
      </div>

      {/* ── Monthly Subscription ───────────────────────────────── */}

      <h2 id="monthly-subscription">Monthly Subscription</h2>
      <p>
        The monthly plan gives you a dedicated GPU for a fixed price. It&apos;s ideal
        for always-on workloads where you know you&apos;ll use the GPU continuously.
      </p>
      <ul>
        <li>A fixed monthly price for one dedicated GPU, shown before you subscribe</li>
        <li>Paid via Stripe &mdash; billed to your credit card, not your wallet</li>
        <li>Your wallet balance is completely separate and unaffected</li>
        <li>Renews automatically on the same day each month</li>
        <li>Cancel from your account page &mdash; the GPU stays active until the end of the billing period</li>
      </ul>

      <div className="not-prose bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 my-6">
        <h4 className="text-blue-800 dark:text-blue-200 font-semibold mb-2 text-base">Monthly vs. Hourly</h4>
        <p className="text-blue-700 dark:text-blue-300 text-sm mb-0">
          To compare, divide the monthly price by 730 (the hours in a month) and set
          it against the hourly price for the same GPU. If you plan to run the GPU
          for most of the month, the subscription is usually cheaper.
        </p>
      </div>

      {/* ── GPU Pricing ────────────────────────────────────────── */}

      <h2 id="gpu-pricing">GPU Pricing</h2>
      <p>
        An hourly instance&apos;s price is the GPU&apos;s rate plus the CPU, memory and
        disk you choose. A shared GPU is priced by the share you rent. The launcher
        shows the full hourly price before you deploy, and that is what your wallet
        is charged.
      </p>
      <p>
        Every instance includes root access, SSH and no bandwidth charges.
      </p>

      {/* ── How the Wallet Works ───────────────────────────────── */}

      <h2 id="how-wallet-works">How the Wallet Works</h2>
      <p>
        Your wallet is a prepaid balance managed through Stripe. It powers all
        hourly GPU usage and persistent storage charges.
      </p>
      <p>
        Wallet charges are the debits recorded in your wallet, including GPU and
        storage charges. Funding, vouchers, and refunds appear separately as
        credits; they are not subtracted from the gross charge totals. Monthly
        subscription payments are also shown separately.
      </p>
      <p>
        Monthly summaries and daily charge charts use UTC. Billing history includes
        all recorded wallet transactions, not just the recent activity preview.
        If the charge ledger cannot be loaded, reports show that it is unavailable
        rather than displaying zero charges.
      </p>

      <h3>Adding Funds</h3>
      <p>
        Top up from your dashboard with $100, $250 or $1,000, or any whole-dollar
        amount from $25 to $10,000.
      </p>
      <p>Funds are available immediately after payment.</p>

      <h3>Voucher Codes</h3>
      <p>
        Promotional vouchers add bonus credits to your wallet. Redeem them
        from the billing section of your dashboard.
      </p>

      <h3>Balance Warnings</h3>
      <p>Keep your balance healthy to avoid interruptions:</p>
      <ul>
        <li><strong>$10 remaining</strong> &mdash; consider adding funds soon</li>
        <li><strong>$5 remaining</strong> &mdash; add funds to avoid interruption</li>
        <li><strong>$0 balance</strong> &mdash; running instances may be paused</li>
      </ul>

      {/* ── Storage Pricing ────────────────────────────────────── */}

      <h2 id="storage-pricing">Storage Pricing</h2>
      <table>
        <thead>
          <tr>
            <th>Storage Type</th>
            <th>Price</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Root disk</strong></td>
            <td>Included in the instance price</td>
            <td>Cleared on terminate</td>
          </tr>
          <tr>
            <td><strong>Persistent volume</strong></td>
            <td>Per GB, billed hourly</td>
            <td>Survives restarts, billed from wallet. Not offered on every GPU</td>
          </tr>
        </tbody>
      </table>
      <p>
        Persistent storage is billed continuously while the volume exists, even if
        the GPU is stopped. Delete the volume to stop storage charges.
      </p>

      {/* ── Cost Management ────────────────────────────────────── */}

      <h2 id="cost-management">Cost Management Tips</h2>

      <h3>1. Terminate When Not in Use</h3>
      <table>
        <thead>
          <tr>
            <th>Instance State</th>
            <th>GPU Billing</th>
            <th>Storage Billing</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><strong>Running</strong></td>
            <td>Active</td>
            <td>Active</td>
          </tr>
          <tr>
            <td><strong>Stopped</strong></td>
            <td>Paused</td>
            <td>Active (if persistent)</td>
          </tr>
          <tr>
            <td><strong>Terminated</strong></td>
            <td>Stopped</td>
            <td>Stopped</td>
          </tr>
        </tbody>
      </table>

      <h3>2. Use Ephemeral Storage When Possible</h3>
      <p>
        Only use persistent storage for data you need to keep across restarts
        (checkpoints, datasets, model weights).
      </p>

      <h3>3. Consider Monthly for Long-Running Workloads</h3>
      <p>
        If you&apos;ll run a GPU for most of the month, a monthly subscription is
        usually cheaper than hourly.
      </p>

      <div className="not-prose bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4 my-6">
        <h4 className="text-red-800 dark:text-red-200 font-semibold mb-2 text-base">Warning</h4>
        <p className="text-red-700 dark:text-red-300 text-sm mb-0">
          Terminating an instance deletes all ephemeral data permanently.
          Save important files to persistent storage or download them first.
        </p>
      </div>

      {/* ── FAQ ────────────────────────────────────────────────── */}

      <h2 id="faq">FAQ</h2>

      <h3>What&apos;s the difference between hourly and monthly?</h3>
      <p>
        <strong>Hourly</strong> is pay-as-you-go from your wallet &mdash; you pay only for the time you use.
        <strong>Monthly</strong> is a flat-rate subscription billed to your credit card,
        giving you a dedicated GPU for the entire month. The two are completely independent.
      </p>

      <h3>Do I get charged for a full hour if I stop early?</h3>
      <p>
        No. Billing is in 30-minute intervals. If you terminate before a 30-minute
        window ends, the unused portion is credited back to your wallet automatically.
      </p>

      <h3>Is the monthly subscription tied to my wallet?</h3>
      <p>
        No. The monthly subscription is billed directly to your credit card via Stripe.
        Your wallet balance is not affected. You can have both a monthly GPU and
        hourly GPUs running at the same time.
      </p>

      <h3>What happens if my wallet runs out?</h3>
      <p>
        Running hourly instances may be paused. Add funds to resume immediately.
        Monthly subscriptions are not affected by your wallet balance.
      </p>

      <h3>Can I switch between hourly and monthly?</h3>
      <p>
        Yes. You can subscribe to a monthly GPU and also deploy hourly GPUs from
        your wallet. To switch an existing GPU from hourly to monthly, terminate the
        hourly instance and subscribe to the monthly plan.
      </p>

      <h3>Can I get a refund on wallet funds?</h3>
      <p>
        Unused prepaid credits can be refunded within 30 days of purchase.
        Contact support for refund requests.
      </p>

      <h3>Do you offer enterprise pricing?</h3>
      <p>
        Yes. Contact us for volume discounts, reserved capacity, and custom SLAs.
      </p>

      <h2>Need Help?</h2>
      <p>
        For billing questions, contact our support team.
      </p>
    </div>
  );
}
