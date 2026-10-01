/**
 * Product pricing helpers for billing enforcement
 */

import { prisma } from "./prisma";

export interface ProductPricing {
  id: string;
  name: string;
  hourly_rate_cents: number;
  poolIds: number[];
  serviceId: string | null;
}

/**
 * Resolve unambiguous legacy hourly pricing. Configurable products require their
 * captured quote, and monthly products must never become hourly backfills.
 */
export async function getProductByPoolId(poolId: string | number, productId?: string | null): Promise<ProductPricing | null> {
  try {
    const numericPoolId = typeof poolId === "string" ? parseInt(poolId, 10) : poolId;

    // Get all active products
    const products = await prisma.gpuProduct.findMany({
      where: { active: true },
    });

    const matches: typeof products = [];
    for (const product of products) {
      try {
        // poolIds is stored as JSON string like "[12,13,14,15]"
        const poolIds: number[] = product.poolIds ? JSON.parse(product.poolIds) : [];
        if (poolIds.includes(numericPoolId)) {
          matches.push(product);
        }
      } catch {
        // Skip malformed poolIds
        continue;
      }
    }

    // A pool alone cannot identify which allocation (and therefore price) was purchased.
    const candidates = productId ? matches.filter(product => product.id === productId) : matches;
    if (candidates.length !== 1) return null;
    const product = candidates[0];
    if (product.configurationPricing || product.billingType === "monthly") return null;
    return {
      id: product.id,
      name: product.name,
      hourly_rate_cents: product.pricePerHourCents,
      poolIds: JSON.parse(product.poolIds || "[]"),
      serviceId: product.serviceId,
    };
  } catch (error) {
    console.error("[Products] Failed to get product by pool ID:", error);
    return null;
  }
}
