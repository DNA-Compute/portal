# hosted.ai Integration Module (`src/lib/hostedai/`)

API client for hosted.ai GPUaaS (GPU-as-a-Service) platform.

## File Structure

```
hostedai/
├── index.ts        # Public exports (use this for imports)
├── types.ts        # TypeScript interfaces for API responses
├── client.ts       # HTTP client with caching
├── teams.ts        # Team/user management
├── billing.ts      # Billing and usage data
├── instances.ts    # VM instance management
├── pools.ts        # GPU pool subscriptions (GPUaaS)
├── metrics.ts      # GPU metrics and monitoring
├── services.ts     # Service exposure (NodePort/LoadBalancer)
└── README.md       # This file
```

## Usage

```typescript
// Import from module root
import {
  createTeam,
  subscribeToPool,
  getPoolSubscriptions,
  getConnectionInfo
} from "@/lib/hostedai";

// Or legacy import (backwards compatible)
import { createTeam } from "@/lib/hostedai";
```

## Core Concepts

### Teams
Each Stripe customer maps to a hosted.ai team:

```typescript
import { createTeam, suspendTeam } from "@/lib/hostedai";

// Create team for new customer
const team = await createTeam({
  name: "Customer Name",
  email: "user@example.com",
  package_id: "pkg_gpu_standard"
});

// Suspend for payment failure
await suspendTeam(team.id);
```

### GPU Pool Subscriptions (GPUaaS)
Provision GPU resources from shared pools:

```typescript
import {
  getAvailablePools,
  subscribeToPool,
  getConnectionInfo,
  unsubscribeFromPool
} from "@/lib/hostedai";

// Find available GPUs
const pools = await getAvailablePools(teamId);

// Subscribe to a pool
const subscription = await subscribeToPool({
  pool_id: pools[0].id,
  team_id: teamId,
  vgpus: 1,
  instance_type_id: "type_medium",
  ephemeral_storage_block_id: "storage_100gb"
});

// Get SSH credentials
const connection = await getConnectionInfo(subscription.subscription_id);
// { host, port, username, password }

// Terminate when done
await unsubscribeFromPool(subscription.subscription_id, teamId);
```

### Configurable Instance Creation

The configurable launch flow discovers provider-supported CPU/RAM profiles and root-disk sizes rather than accepting arbitrary dimensions. Discovery uses `/api/service/i/` endpoints with `service_id`, `team_id`, and `region_id`:

| Endpoint | Additional query parameters |
| --- | --- |
| `provisioning-info` | None |
| `compatible-gpu-pools`, `compatible-gpu-models` | None |
| `compatible-images` | `requested_gpu_count`, `pool_id` or `model_id` |
| `instance-types` | Image parameters plus `image_hash` |
| `storage-blocks` | Profile parameters plus `instance_type` |
| `shared-volumes` | `requested_gpu_count`, `pool_id` |

`getLaunchServiceResources` sends only the parameters for that discovery stage. In particular, profile discovery must not depend on an already-selected profile.

Hourly resource selection follows provider locks, independently of retail pricing. An absent/null `image_details` policy does not lock the image selector: choices must still pass scoped `compatible-images` discovery. Creation retains the policy `service_id` and sends the selected `instance_type_id`, `image_hash`, and `root_storage_type_id`; service defaults must not replace those selections. Without resource rates, only the complete original default allocation may be quoted, not the current selection relabeled as a default.

This sequence matches the [provider's native creation client](https://user.srv103590.hostedai.cloud/assets/create-Dag_P9M2.js) inspected on 2026-09-18. Its [published Swagger](https://user.srv103590.hostedai.cloud/api/docs/swagger/doc.json) has conflicting `cluster_id` annotations and an older create-payload reference; do not replace `region_id` based solely on those annotations. Confirm the contract against the deployment configured in `HOSTEDAI_API_URL`.

Creation uses `POST /api/service/i/create-instance` with nested `pod_opts` or `vm_opts`. The response can be a JSON string containing the instance ID. Fresh pod launches and snapshot restores request root persistence by default, including legacy responses without capability metadata. Only marketplace pools explicitly reporting `rootfs_persistence_capable: false` disable that request; owned pools retain it. Marketplace `shared_storage_capable: false` prevents advertising or selecting shared volumes, and incompatible snapshot attachments are rejected before prepayment. Configurator quotes warn when the root disk is ephemeral and bind this policy into the quote fingerprint. These rules follow the published `types.GpuaasPool` capability contract, not a live reboot/persistence test.

API-key authentication uses the `X-API-Key` header, as specified by `securityDefinitions.ApiKeyAuth`. An anonymous response mentioning a missing `Authorization` header does not establish that bearer authentication is required.

Pool binding remains strict: multiple default pools require an explicit offering binding rather than selecting the first. For GPU pods, the native client's explicit `max_quantity: 0` removes the service-level cap only; actual whole-GPU pool capacity and the 256-GPU request limit still apply. Missing limits remain invalid, zero actual capacity remains unavailable, and GPU VM `max_quantity: 0` does not imply unlimited capacity.

Authenticated verification is still required before paid launches. In particular, the native client sends registered provider SSH-key IDs in `public_keys`, while this portal currently sends raw OpenSSH public keys. Whether the configured deployment accepts both representations is not established by public assets or local fixtures.

### Billing

Native `total_cost` and resource-cost fields are Hosted.ai accounting values, not Packet retail charges or proof of supplier payment. Packet owns its retail rate cards and accepted workload-rate snapshots. Customer wallet-charge reports read the Stripe balance ledger: positive USD debits excluding invoice hold/restore bookkeeping, with funding, vouchers, and refunds shown separately as credits. Shared-storage charges are identified by `metadata.billing_type === "storage"`; monthly Stripe subscriptions remain separate. Native summaries may supply usage quantities, but never derive hours from a monetary total or substitute native costs when the retail ledger is unavailable.

For marketplace-backed capacity, inspect the linked organisation's wallet for supplier debits and automatic top-up settings. That wallet, native team-policy accrual, and Packet's customer Stripe ledger are separate accounting surfaces. An empty native invoice listing does not establish that organisation-wallet collection is disabled.

```typescript
import { getTeamBillingSummaryV2 } from "@/lib/hostedai";

const billing = await getTeamBillingSummaryV2(
  teamId,
  "2024-01-01T00:00:00Z",
  "2024-01-31T23:59:59Z"
);
// { total_cost, pool_hours, gpuaas_summary }
```

### Service Exposure
Expose services running on GPU pods:

```typescript
import { exposeService, getExposedServices } from "@/lib/hostedai";

// Expose vLLM API server
await exposeService(subscriptionId, teamId, {
  port: 8000,
  service_type: "LoadBalancer"
});

// Get external endpoints
const services = await getExposedServices(subscriptionId, teamId);
```

## Caching

The client includes an in-memory cache for frequently accessed data:

```typescript
import { clearCache } from "@/lib/hostedai";

// Clear all cached data
clearCache();
```

Cache TTLs vary by endpoint type:
- Pool lists: 5 minutes
- Instance types: 10 minutes
- Billing data: No cache

Default policies use a separate 24-hour cache. Await `getDefaultPolicies()` before creating a team or changing its policies: concurrent callers share the same `/policy/defaults?nature=general` lookup. Cold failures reject; a failed refresh can retain only a complete set previously fetched successfully. There are no hardcoded fallback IDs or synchronous getters. `clearDefaultPoliciesCache()` also invalidates outstanding lookup ownership, preventing an older response from repopulating the cache. Capture a resolved policy ID once for a resource read/write operation.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HOSTEDAI_API_URL` | Yes | API base URL |
| `HOSTEDAI_API_KEY` | Yes | API authentication key |
| `DEFAULT_USER_PASSWORD` | No | Default password for pre-onboarded users |
| `DEFAULT_IMAGE_UUID` | No | Fallback VM image UUID |

## Error Handling

All functions throw descriptive errors:

```typescript
try {
  await subscribeToPool({ ... });
} catch (error) {
  if (error.message.includes("No GPUs available")) {
    // Handle capacity issues
  }
  if (error.message.includes("Already subscribed")) {
    // Handle duplicate subscription
  }
}
```

## Important Notes

1. **Image IDs**: The `/policy/image` endpoint returns hash-format IDs (64 chars), but the subscribe API expects UUID format. Use `DEFAULT_IMAGE_UUID` as fallback.

2. **Instance Types**: Use `gpu_workload: true` types from `/instance-type`. The `/gpuaas/pool/compatible-instance-types` endpoint returns incorrect types.

3. **User Pre-onboarding**: Pass `password` and `pre_onboard: true` in the team member object during team creation. Don't use the separate `/api/onboard` endpoint.
