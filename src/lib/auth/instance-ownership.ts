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
 * instance's team is compared again here, since hosted.ai has returned other teams' rows before;
 * a row with no team cannot be shown to be this team's, so it does not count.
 * Accepts the `instance-<id>` form saved as PodMetadata.subscriptionId. Only a confirmed owner is
 * cached (briefly, by the client cache), so a refusal is always rechecked and polling stays cheap.
 */
export async function ownsInstance(teamIds: readonly (string | null | undefined)[], id: string | null | undefined): Promise<boolean> {
  const instanceId = canonicalInstanceId(id);
  if (!instanceId) return false;
  for (const teamId of new Set(teamIds.filter((team): team is string => !!team).map(String))) {
    const cacheKey = `instance-owner:${teamId}:${instanceId}`;
    if (getCached<boolean>(cacheKey)) return true;
    const seen = new Set<string>();
    for (let page = 0; page < MAX_PAGES; page++) {
      const { items = [], total_items: total } = await getUnifiedInstances(teamId, page, PAGE_SIZE);
      if (items.some(item => item.id === instanceId && item.team?.id != null && String(item.team.id) === teamId)) {
        setCache(cacheKey, true);
        return true;
      }
      const before = seen.size;
      for (const item of items) seen.add(item.id);
      // A short page is the last one; the total, when hosted.ai sends it, can end the walk sooner,
      // and a page with nothing new means hosted.ai is not paging, so asking again cannot help.
      if (items.length < PAGE_SIZE || seen.size === before || (typeof total === "number" && seen.size >= total)) break;
    }
  }
  return false;
}

/** The instance id in its hosted.ai form, without the `instance-` prefix PodMetadata.subscriptionId carries. */
export function canonicalInstanceId(id: string | null | undefined): string {
  return String(id ?? "").replace(/^instance-/, "");
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
