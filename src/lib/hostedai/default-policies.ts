/**
 * Fetches general default policy IDs from Hosted.ai and caches verified sets.
 * A failed refresh may retain a previously fetched set; cold failures reject.
 */

import { hostedaiRequest } from "./client";

interface DefaultPolicies {
  pricing: string;
  resource: string;
  service: string;
  instanceType: string;
  image: string;
}

let cachedPolicies: DefaultPolicies | null = null;
let lastFetchTime = 0;
let inFlight: Promise<DefaultPolicies> | null = null;

// Cache duration: 24 hours (policies rarely change)
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000;
const policyTypes: Record<string, keyof DefaultPolicies> = {
  pricing: "pricing",
  resource: "resource",
  service: "service",
  "instance-type": "instanceType",
  image: "image",
};
const requiredKeys: (keyof DefaultPolicies)[] = ["pricing", "resource", "service", "instanceType", "image"];

function mapPolicyType(type: string): keyof DefaultPolicies | null {
  return Object.prototype.hasOwnProperty.call(policyTypes, type) ? policyTypes[type] : null;
}

async function fetchDefaultPoliciesFromAPI(): Promise<DefaultPolicies> {
  // Ariel has general and baremetal defaults per type. Keep the general scope
  // so a baremetal ID can never overwrite the policy used for customer teams.
  // Titan (pre-ariel) ignores the query parameter and returns one per type.
  const response = await hostedaiRequest<unknown>("GET", "/policy/defaults?nature=general");
  if (!Array.isArray(response)) {
    throw new Error("Hosted.ai returned an invalid default policies response");
  }

  const policies: Partial<DefaultPolicies> = {};
  for (const policy of response) {
    if (!policy || typeof policy !== "object" || typeof policy.type !== "string") {
      throw new Error("Hosted.ai returned an invalid default policy entry");
    }
    const key = mapPolicyType(policy.type);
    if (!key) continue;
    if (typeof policy.id !== "string" || policy.id.trim().length === 0) {
      throw new Error(`Hosted.ai returned an invalid default policy ID for ${policy.type}`);
    }
    policies[key] = policy.id;
  }

  const missingKeys = requiredKeys.filter((key) => !policies[key]);
  if (missingKeys.length > 0) {
    throw new Error(`Hosted.ai is missing required default policies: ${missingKeys.join(", ")}`);
  }
  return policies as DefaultPolicies;
}

/**
 * Returns fresh cached defaults or awaits a shared lookup. Only a previously
 * verified set can be returned if refreshing fails; cold lookups reject.
 */
export async function getDefaultPolicies(): Promise<DefaultPolicies> {
  if (cachedPolicies && Date.now() - lastFetchTime < CACHE_DURATION_MS) {
    return cachedPolicies;
  }
  if (inFlight) return inFlight;

  const previousPolicies = cachedPolicies;
  const lookup = fetchDefaultPoliciesFromAPI()
    .then((policies) => {
      // Clearing the cache transfers ownership to the next lookup. Existing
      // callers can still finish, but their result must not repopulate it.
      if (inFlight === lookup) {
        cachedPolicies = policies;
        lastFetchTime = Date.now();
      }
      return policies;
    })
    .catch((error: unknown) => {
      if (previousPolicies) {
        console.error("[DefaultPolicies] Refresh failed, retaining verified policies:", error);
        return previousPolicies;
      }
      throw error;
    })
    .finally(() => {
      if (inFlight === lookup) inFlight = null;
    });
  inFlight = lookup;
  return lookup;
}

/** Invalidates cached defaults and ownership of any outstanding lookup. */
export function clearDefaultPoliciesCache(): void {
  cachedPolicies = null;
  lastFetchTime = 0;
  inFlight = null;
}

/** Pre-warms the cache; initialization fails if no verified defaults exist. */
export async function initializeDefaultPolicies(): Promise<void> {
  await getDefaultPolicies();
}
