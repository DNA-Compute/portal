# GPU Cloud Dashboard

**Built on [hosted.ai](https://hosted.ai)** | Next.js 16 | Prisma/MariaDB | Stripe

A full-featured GPU cloud platform dashboard powered by the **[hosted.ai](https://hosted.ai)** GPU infrastructure API. Fork and deploy to run your own GPU-as-a-Service business.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/hosted-ai/packet-oss/main/install.sh | sudo bash
```

Installs to `/opt/packet-oss` with MariaDB, systemd, and Apache reverse proxy. Requires a fresh Linux server (Ubuntu/Debian).

---

**This platform requires [hosted.ai](https://hosted.ai).** All GPU pod deployment, orchestration, scaling, monitoring, and billing runs through the hosted.ai API. You need a hosted.ai account and API credentials for the platform to function. Visit [hosted.ai](https://hosted.ai) to get access.

## Features

- **Customer Dashboard** - Deploy & manage GPU instances, SSH keys, team members, billing
- **Admin Panel** - 30+ tabs for managing customers, pods, products, pricing, providers, and more
- **Provider Portal** - GPU providers can manage nodes, pricing, and payouts
- **Investor Portal** - Revenue tracking and performance dashboards
- **Stripe Billing** - Optional prepaid wallets, subscriptions, and payment processing
- **Web SSH Terminal** - Browser-based terminal access to GPU instances
- **Marketing Pages** - Landing page, GPU product pages, comparison pages, docs
- **Two-Factor Auth** - TOTP-based 2FA for admin security
- **Referral & Voucher System** - Built-in referral codes and discount vouchers
- **Platform Settings** - Configure all API keys and settings from the admin UI

## Prerequisites

- **[hosted.ai](https://hosted.ai) account** - Required for GPU pod management
- **Node.js 18+** and **pnpm 8+**
- **MariaDB 10.6+** (or MySQL 8.0+)
- **Domain + SSL/HTTPS** - Required for any non-localhost deploy. Admin session cookies are marked `secure`, so login breaks over plain HTTP. `install.sh` provisions this automatically via Let's Encrypt + Apache when you supply a domain.
- **Stripe account** (optional) - For billing features

## Manual Setup

```bash
# 1. Clone and install
git clone https://github.com/hosted-ai/packet-oss.git && cd packet-oss
pnpm install

# 2. Create environment file
cp .env.example .env.local

# 3. Configure database URL in .env.local
# DATABASE_URL="mysql://gpucloud:password@localhost:3306/gpucloud"

# 4. Initialize the database
npx prisma db push

# 5. Start development server
pnpm dev

# 6. Set up your admin account
# Visit http://localhost:3000/admin
# Create your admin account with email + password
# Go to Platform Settings to configure your hosted.ai API keys
```

## Configuration

### Zero-Config Boot

The app boots and runs with just `DATABASE_URL` configured. All other settings can be configured through the admin panel at **Admin > Platform Settings**.

**Important:** While the app starts without any API keys, GPU features (pod deployment, management, monitoring) require a [hosted.ai](https://hosted.ai) API connection. Configure your hosted.ai credentials in Platform Settings after your first login.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | MariaDB connection string |
| `EDITION` / `NEXT_PUBLIC_EDITION` | Yes (OSS) | Set both to `oss`; Pro modules are not included in this source tree |
| `TENANT_ENCRYPTION_KEY` | For gated/private models | Stable 64-character hexadecimal key for encrypted Hugging Face access tokens |
| `NEXT_PUBLIC_APP_URL` | No | Your app's public URL (default: `http://localhost:3000`) |
| `ADMIN_JWT_SECRET` | No | Auto-generated if not set |
| `STRIPE_SECRET_KEY` | No | Enables billing features |
| `HOSTEDAI_API_URL` | **Yes*** | hosted.ai API URL (required for GPU features) |
| `HOSTEDAI_API_KEY` | **Yes*** | hosted.ai API key (required for GPU features) |
| `SMTP_HOST` | No | Enables email notifications (SMTP server) |

*hosted.ai credentials are required for GPU functionality but the app will boot without them. Configure via admin UI or .env file.

### Configurable GPU Launches

The dashboard, Apps, and Hugging Face entry points share one launch flow: GPU and region, supported CPU/RAM and storage, optional software, name/SSH keys, then an itemized quote.

- Apply `pnpm exec prisma migrate deploy` and regenerate the Prisma client before running this version against an existing database. The configuration migration adds resource/rate snapshots and expands encrypted model-token storage.
- Hourly offerings can use enabled, unlocked hosted.ai services. End users select supported CPU/RAM profiles and root disks; actual provider locks still apply. Keep one policy service per GPU offering rather than creating a service for every RAM/disk combination. Monthly entitlements retain their included allocation.
- Under **Admin > Products**, choose **GPU base plus resource rates** to price custom allocations. The hourly product price becomes the per-GPU base; CPU-core, RAM-GB, and root-GB hourly rates are additional and entered in cents. **Bundled defaults only** does not lock discovery, but permits quoting only the complete original service-default allocation. Other selections return `RESOURCE_PRICING_UNAVAILABLE` before payment or provisioning.
- Bind pod offerings to explicit product pool IDs or one unambiguous service default. GPU VM offerings use the service's default GPU model and require automatic public/private networking (`auto_assign_network: both`). GPU memory comes from the bound offering's declared VRAM, limited by provider memory when supplied.
- Resource choices are discovered for the operating account and revalidated before payment. Compute components round to whole cents per hour, and each billing-interval prepayment rounds to whole cents. Persistent shared storage retains fractional-cent metering and is charged separately until deletion, even after the last instance is removed. Attaching an existing volume does not create another storage charge.
- New instances save a whole-instance rate and stopped-rate snapshot. Running and stopped reservations use their actual paid intervals for settlement; existing historical per-GPU rates are not rewritten. Unquoted resize/recreation paths reject configured instances.
- Hugging Face installs support validated, non-quantized Transformers causal language models on the native FP16 vLLM runtime. GPU memory, tensor parallelism, CPU/RAM, and root/model-cache capacity must fit before launch. Unsupported models must use an appropriate managed recipe instead.
- The launch picker marks unsupported runtimes unavailable and gated/unverifiable models as unverified. Quote-time checks remain authoritative. Model size is not constrained by the old fixed-disk UI limit; select sufficient supported root or persistent storage.
- Both Hugging Face browsers also offer **Install on existing GPU**. Select a running instance and confirm that its current model workload may be replaced. This starts installation without creating another GPU or changing its compute price; accepted installation is not a readiness confirmation.
- API clients discover choices with `GET /api/instances/configuration`, request `POST /api/instances/quote`, and submit the returned fingerprint with the full configuration to `POST /api/instances`. Every launch requires a reviewed quote; the old flat SKU launch body and separate Apps/Hugging Face create endpoints are removed.
- Checkout return restores non-secret choices and the operating account. Hugging Face tokens and custom startup scripts must be re-entered; neither is saved in the browser draft.
- Set a persistent `TENANT_ENCRYPTION_KEY` containing exactly 64 hexadecimal digits (`openssl rand -hex 32`) before token-bearing model launches. Missing or invalid keys produce a startup diagnostic and block those launches before payment; public models without tokens remain available. Keep the key backed up to read existing encrypted credentials.

Before production rollout, verify the enabled services and a complete paid launch against your own hosted.ai/Stripe staging accounts. Local fixtures cannot establish live capacity or provider provisioning success.

## Tech Stack

- **Framework**: Next.js 16 (App Router, React 19)
- **Database**: MariaDB with Prisma ORM
- **Styling**: Tailwind CSS 4
- **Payments**: Stripe (optional)
- **GPU Backend**: [hosted.ai](https://hosted.ai) API (required)
- **Auth**: JWT (jsonwebtoken) with password + optional TOTP 2FA
- **Process Manager**: PM2

## Architecture

```
src/
  app/                    # Next.js App Router
    (marketing)/          # Public marketing pages
    account/              # Customer account
    admin/                # Admin panel (SPA, tab routing via ?tab=)
    api/                  # API routes
      admin/              # Admin API
      cron/               # Scheduled jobs
      webhooks/           # Stripe webhooks
    dashboard/            # Customer GPU dashboard
    terminal/             # Web SSH terminal
  components/             # Shared React components
  lib/                    # Server-side business logic
    auth/                 # JWT auth (admin + customer)
    email/                # Email templates
    hostedai/             # GPU infrastructure client
    settings.ts           # Platform settings (DB-backed)
  middleware.ts           # POST request blocking
prisma/schema.prisma      # Database schema
```

## CLI Tool

A command-line interface is included for managing GPU instances:

```bash
cd cli && npm install -g .

gpu-cloud login
gpu-cloud gpus
gpu-cloud launch --gpu h100 --setup vscode
gpu-cloud ps
gpu-cloud ssh <instance-id>
```

See [cli/README.md](cli/README.md) for full documentation.

## Production Deployment

```bash
# Build for production
pnpm build

# Start with PM2
pm2 start ecosystem.config.cjs

# Or start directly
pnpm start
```

See `install.sh` for automated server setup with systemd and Apache.

## Upgrade

```bash
sudo bash upgrade.sh                    # Upgrade to latest
sudo bash upgrade.sh --branch v1.2.0    # Upgrade to specific version
```

## Reconfigure

```bash
sudo bash reconfigure.sh                         # Interactive menu
sudo bash reconfigure.sh --domain new.example.com # Change domain
sudo bash reconfigure.sh --ssl-on                 # Enable SSL
sudo bash reconfigure.sh --check                  # Health diagnostics
```

## Development

```bash
pnpm dev              # Start dev server
pnpm build            # Production build
pnpm lint             # ESLint
pnpm test:unit        # Vitest tests
pnpm test:e2e         # Playwright E2E tests
npx tsc --noEmit      # Type check
```

## GPU Backend

This platform is built on the [hosted.ai](https://hosted.ai) GPU infrastructure API. All GPU pod lifecycle management - deployment, scaling, monitoring, billing, and orchestration - is handled through hosted.ai. You must have a hosted.ai account with API credentials to operate GPU features.

To get started with hosted.ai, visit [hosted.ai](https://hosted.ai).

## License

MIT
