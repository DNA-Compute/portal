import { NextResponse } from "next/server";
import { getCached, setCache } from "@/lib/hostedai/client";
import { getUnifiedInstances } from "@/lib/hostedai/instances";
import { getExposedServices } from "@/lib/hostedai/services";

const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/**
 * Whether the instance `id` belongs to one of `teamIds`.
 *
 * The portal calls hosted.ai with one platform-wide API key, so hosted.ai will read, change or
 * delete any instance it is given an id for. Every customer route that takes an instance id must
 * check it here first. Ownership comes from each team's own instance list, and each listed
 * instance's team is compared again here, since hosted.ai has returned other teams' rows before.
 * Accepts the `instance-<id>` form saved as PodMetadata.subscriptionId. Only a confirmed owner is
 * cached (briefly, by the client cache), so a refusal is always rechecked and polling stays cheap.
 */
export async function ownsInstance(teamIds: readonly (string | null | undefined)[], id: string | null | undefined): Promise<boolean> {
  const instanceId = String(id ?? "").replace(/^instance-/, "");
  if (!instanceId) return false;
  for (const teamId of new Set(teamIds.filter((team): team is string => !!team).map(String))) {
    const cacheKey = `instance-owner:${teamId}:${instanceId}`;
    if (getCached<boolean>(cacheKey)) return true;
    let seen = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { items = [], total_items: total = 0 } = await getUnifiedInstances(teamId, page, PAGE_SIZE);
      if (items.some(item => item.id === instanceId && (item.team?.id == null || String(item.team.id) === teamId))) {
        setCache(cacheKey, true);
        return true;
      }
      seen += items.length;
      if (items.length < PAGE_SIZE || seen >= total) break;
    }
  }
  return false;
}

/** A 404 for an instance the caller does not own (the same answer as one that does not exist), or null. */
export async function rejectUnownedInstance(teamIds: readonly (string | null | undefined)[], id: string | null | undefined): Promise<NextResponse | null> {
  return (await ownsInstance(teamIds, id)) ? null : NextResponse.json({ error: "Instance not found" }, { status: 404 });
}

/** A 404 unless exposed service `serviceId` is one of an owned instance's own services, or null. */
export async function rejectUnownedService(teamIds: readonly (string | null | undefined)[], instanceId: string | null | undefined, serviceId: unknown): Promise<NextResponse | null> {
  const notFound = NextResponse.json({ error: "Service not found" }, { status: 404 });
  if (!(await ownsInstance(teamIds, instanceId))) return notFound;
  const services = (await getExposedServices(String(instanceId))) ?? [];
  return Array.isArray(services) && services.some(service => String(service.id) === String(serviceId)) ? null : notFound;
}
