/**
 * GPU Products Admin API
 *
 * GET - List all GPU products (with categories)
 * POST - Create/update/delete GPU products and categories
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { configurationPricingSchema } from "@/lib/launch-config";
import type { ConfigurationPricing } from "@/lib/launch-config";
import { getHAIService, hostedaiRequest, updateHAIService } from "@/lib/hostedai";
import { clearCache } from "@/lib/hostedai/client";
import { assignGpuService, createCategoryScenario, syncServiceScenarios } from "@/lib/scenarios";

const productPoolIdsSchema = z.array(z.number().int().positive());

const productPricingSchema = z.object({
  billingType: z.enum(["hourly", "monthly"]),
  pricePerHourCents: z.number().int().nonnegative().max(2_147_483_647),
  pricePerMonthCents: z.number().int().nonnegative().max(2_147_483_647).nullable().optional(),
  configurationPricing: configurationPricingSchema.nullable().optional(),
}).superRefine((pricing, ctx) => {
  if (pricing.billingType === "monthly") {
    if (pricing.configurationPricing != null) {
      ctx.addIssue({ code: "custom", message: "Monthly products are fixed entitlements and cannot have configuration pricing." });
    }
    if (pricing.pricePerMonthCents == null) {
      ctx.addIssue({ code: "custom", message: "Monthly price is required." });
    }
  }
});

interface GpuProductInput {
  name: string;
  description?: string;
  billingType?: string;
  pricePerHourCents: number;
  pricePerMonthCents?: number | null;
  configurationPricing?: ConfigurationPricing | null;
  stripeProductId?: string | null;
  stripePriceId?: string | null;
  poolIds: number[];
  displayOrder?: number;
  active?: boolean;
  featured?: boolean;
  badgeText?: string;
  vramGb?: number;
  cudaCores?: number;
  gpuFamily?: string | null;
  serviceId?: string | null;
  categoryIds?: string[];
}

interface HAIServiceFull {
  id: string;
  name: string;
  service_type: string;
  is_enabled: boolean;
  gpu_config?: {
    default_gpu_pools?: unknown;
    default_gpu_model_id?: unknown;
  } | null;
  instance_config?: {
    default_instance_type_id?: string | null;
    default_storage_block_id?: string | null;
    default_image_hash_id?: string | null;
    instance_type_locked?: boolean;
    storage_block_locked?: boolean;
    image_locked?: boolean;
    auto_assign_network?: string | null;
  } | null;
}

/**
 * Validate a HAI service for product linking:
 * - Must exist, be enabled, and have a compatible GPU service type
 * - Must not already be linked to another product (excludeProductId for updates)
 * - Monthly offerings require locked defaults; hourly offerings preserve HAI policy
 */
async function validateServiceForProduct(
  serviceId: string,
  billingType: "hourly" | "monthly",
  poolIds: number[],
  excludeProductId?: string
): Promise<{ error: string } | { service: HAIServiceFull }> {
  // 1. Check uniqueness — service can only belong to one product
  const existingProduct = await prisma.gpuProduct.findFirst({
    where: {
      serviceId,
      ...(excludeProductId ? { id: { not: excludeProductId } } : {}),
    },
    select: { id: true, name: true },
  });
  if (existingProduct) {
    return { error: `Service is already linked to product "${existingProduct.name}". A service can only belong to one product.` };
  }

  // 2. Fetch and validate the HAI service
  let svc: HAIServiceFull;
  try {
    clearCache(`/service/${serviceId}`);
    svc = await hostedaiRequest<HAIServiceFull>("GET", `/service/${serviceId}`);
  } catch (err) {
    console.error("[Admin] Failed to validate HAI service:", err);
    return { error: "Failed to reach HAI service. Check the service ID." };
  }

  if (!svc || !svc.id) {
    return { error: "HAI service not found. Check the service ID." };
  }
  const allowedTypes = billingType === "hourly" ? ["pod_accelerator", "cpu_gpu_card"] : ["pod_accelerator"];
  if (!allowedTypes.includes(svc.service_type)) {
    return { error: `Service "${svc.name}" is type "${svc.service_type}" — must be ${allowedTypes.join(" or ")} for this offering.` };
  }
  if (!svc.is_enabled) {
    return { error: `Service "${svc.name}" is disabled in HAI. Enable it first.` };
  }
  if (billingType === "hourly") {
    if (svc.service_type === "pod_accelerator" && poolIds.length === 0) {
      const defaults = productPoolIdsSchema.safeParse(svc.gpu_config?.default_gpu_pools);
      if (!defaults.success || defaults.data.length !== 1) {
        return { error: `Service "${svc.name}" does not identify one default GPU pool. Assign this offering's GPU pools explicitly, or set exactly one default pool in HAI. Its GPU base rate cannot cover arbitrary compatible hardware.` };
      }
    }
    if (svc.service_type === "cpu_gpu_card" &&
        (typeof svc.gpu_config?.default_gpu_model_id !== "string" || !svc.gpu_config.default_gpu_model_id.trim())) {
      return { error: `Service "${svc.name}" needs a default GPU model in HAI. An hourly GPU VM offering's base rate is tied to that model.` };
    }
    if (svc.service_type === "cpu_gpu_card" && svc.instance_config?.auto_assign_network !== "both") {
      return { error: `Service "${svc.name}" must automatically assign both networks in HAI (auto_assign_network: both). GPU VM launch does not offer manual network selection.` };
    }
    return { service: svc };
  }

  // 3. Monthly entitlements must have included defaults set and locked.
  const ic = svc.instance_config;
  const missing: string[] = [];
  if (!ic?.default_instance_type_id) missing.push("instance type");
  if (!ic?.default_storage_block_id) missing.push("storage block");
  if (!ic?.default_image_hash_id) missing.push("image");

  if (missing.length > 0) {
    return { error: `Service "${svc.name}" is missing default ${missing.join(", ")} in HAI. Set these in the HAI admin panel before linking.` };
  }

  const unlocked: string[] = [];
  if (!ic?.instance_type_locked) unlocked.push("instance type");
  if (!ic?.storage_block_locked) unlocked.push("storage block");
  if (!ic?.image_locked) unlocked.push("image");

  if (unlocked.length > 0) {
    return { error: `Service "${svc.name}" has unlocked ${unlocked.join(", ")}. Lock these in HAI admin panel so users get consistent provisioning.` };
  }

  return { service: svc };
}

export async function GET(request: NextRequest) {
  try {
    const sessionToken = request.cookies.get("admin_session")?.value;
    if (!sessionToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const session = verifySessionToken(sessionToken);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [products, categories] = await Promise.all([
      prisma.gpuProduct.findMany({
        orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
        include: { categories: { select: { id: true, name: true } } },
      }),
      prisma.gpuCategory.findMany({
        orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
      }).catch(() => []),
    ]);

    // Parse poolIds from JSON string, flatten categories to categoryIds
    const formattedProducts = products.map((p) => ({
      ...p,
      poolIds: JSON.parse(p.poolIds),
      categoryIds: p.categories.map((c: { id: string }) => c.id),
    }));

    return NextResponse.json({ success: true, data: formattedProducts, categories });
  } catch (err) {
    console.error("GPU Products GET error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessionToken = request.cookies.get("admin_session")?.value;
    if (!sessionToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const session = verifySessionToken(sessionToken);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const adminEmail = session.email;
    const body = await request.json();
    const { action, id, ...data } = body as { action: string; id?: string } & Partial<GpuProductInput>;

    switch (action) {
      case "create": {
        if (!data.name || data.pricePerHourCents === undefined) {
          return NextResponse.json({ error: "Name and price are required" }, { status: 400 });
        }
        if (!data.serviceId) {
          return NextResponse.json({ error: "HAI Service is required" }, { status: 400 });
        }
        const pricing = productPricingSchema.safeParse({
          billingType: data.billingType ?? "hourly",
          pricePerHourCents: data.pricePerHourCents,
          pricePerMonthCents: data.pricePerMonthCents,
          configurationPricing: data.configurationPricing,
        });
        if (!pricing.success) {
          return NextResponse.json({ error: pricing.error.issues.map(issue => issue.message).join(" ") }, { status: 400 });
        }
        const pools = productPoolIdsSchema.safeParse(data.poolIds !== undefined ? data.poolIds : []);
        if (!pools.success) {
          return NextResponse.json({ error: "Pool IDs must be an array of positive integers." }, { status: 400 });
        }

        // Validate HAI service: uniqueness + type + config completeness
        const result = await validateServiceForProduct(data.serviceId, pricing.data.billingType, pools.data);
        if ("error" in result) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }

        const product = await prisma.gpuProduct.create({
          data: {
            name: data.name,
            description: data.description || null,
            billingType: pricing.data.billingType,
            pricePerHourCents: pricing.data.pricePerHourCents,
            pricePerMonthCents: pricing.data.pricePerMonthCents ?? null,
            configurationPricing: pricing.data.configurationPricing ?? Prisma.DbNull,
            stripeProductId: data.stripeProductId ?? null,
            stripePriceId: data.stripePriceId ?? null,
            poolIds: JSON.stringify(data.poolIds || []),
            displayOrder: data.displayOrder || 0,
            active: data.active ?? true,
            featured: data.featured ?? false,
            badgeText: data.badgeText || null,
            vramGb: data.vramGb || null,
            cudaCores: data.cudaCores || null,
            gpuFamily: data.gpuFamily || null,
            serviceId: data.serviceId ?? null,
            categories: data.categoryIds?.length
              ? { connect: data.categoryIds.map(id => ({ id })) }
              : undefined,
            createdBy: adminEmail,
            updatedBy: adminEmail,
          },
        });

        // Only explicit pool assignments change HAI. The wrapper deep-merges gpu_config,
        // preserving the service's existing lock policy and all other hardware settings.
        if (data.serviceId) {
          if (data.poolIds !== undefined && result.service.service_type === "pod_accelerator" &&
              (pricing.data.billingType === "monthly" || pools.data.length > 0)) {
            try {
              await updateHAIService(data.serviceId, {
                gpu_config: { default_gpu_pools: data.poolIds },
              });
            } catch (err) {
              console.error("[Admin] Failed to sync pools to HAI service:", err);
            }
          }
          // Sync service scenarios via PUT /api/service (updates scenarios array)
          try {
            if (data.categoryIds?.length) {
              await syncServiceScenarios(data.serviceId!, data.categoryIds!);
            } else {
              await assignGpuService(data.serviceId!);
            }
          } catch (err) {
            console.error("[Admin] Scenario sync on create failed:", err);
          }
        }

        return NextResponse.json({
          success: true,
          data: { ...product, poolIds: JSON.parse(product.poolIds), categoryIds: data.categoryIds || [] },
        });
      }

      case "update": {
        if (!id) {
          return NextResponse.json({ error: "Product ID is required" }, { status: 400 });
        }

        // Fetch existing product with categories to detect changes
        const existing = await prisma.gpuProduct.findUnique({
          where: { id },
          include: { categories: { select: { id: true } } },
        });
        if (!existing) {
          return NextResponse.json({ error: "Product not found" }, { status: 404 });
        }
        const existingCategoryIds = existing.categories.map((c: { id: string }) => c.id);

        // HAI Service is required — reject explicit unset
        if (data.serviceId !== undefined && !data.serviceId) {
          return NextResponse.json({ error: "HAI Service is required" }, { status: 400 });
        }

        const pricing = productPricingSchema.safeParse({
          billingType: data.billingType !== undefined ? data.billingType : existing.billingType,
          pricePerHourCents: data.pricePerHourCents !== undefined ? data.pricePerHourCents : existing.pricePerHourCents,
          pricePerMonthCents: data.pricePerMonthCents !== undefined ? data.pricePerMonthCents : existing.pricePerMonthCents,
          configurationPricing: data.configurationPricing !== undefined ? data.configurationPricing : existing.configurationPricing,
        });
        if (!pricing.success) {
          return NextResponse.json({ error: pricing.error.issues.map(issue => issue.message).join(" ") }, { status: 400 });
        }
        const effectiveServiceId = data.serviceId !== undefined ? data.serviceId : existing.serviceId;
        const oldPoolIds: number[] = JSON.parse(existing.poolIds || "[]");
        const pools = productPoolIdsSchema.safeParse(data.poolIds !== undefined ? data.poolIds : oldPoolIds);
        if (!pools.success) {
          return NextResponse.json({ error: "Pool IDs must be an array of positive integers." }, { status: 400 });
        }
        const poolsChanged = data.poolIds !== undefined &&
          (effectiveServiceId !== existing.serviceId ||
            data.poolIds.length !== oldPoolIds.length ||
            data.poolIds.some(poolId => !oldPoolIds.includes(poolId)));
        const previousRateCard = configurationPricingSchema.nullable().safeParse(existing.configurationPricing);
        const oldRates = previousRateCard.success ? previousRateCard.data : null;
        const newRates = pricing.data.configurationPricing ?? null;
        const rateCardChanged = !previousRateCard.success ||
          (oldRates === null) !== (newRates === null) ||
          oldRates?.cpuCoreHourCents !== newRates?.cpuCoreHourCents ||
          oldRates?.ramGbHourCents !== newRates?.ramGbHourCents ||
          oldRates?.rootGbHourCents !== newRates?.rootGbHourCents ||
          (oldRates?.fractionalGpu ?? false) !== (newRates?.fractionalGpu ?? false);
        const pricingChanged = rateCardChanged ||
          pricing.data.billingType !== existing.billingType ||
          pricing.data.pricePerHourCents !== existing.pricePerHourCents ||
          (pricing.data.pricePerMonthCents ?? null) !== existing.pricePerMonthCents ||
          (data.stripeProductId !== undefined && data.stripeProductId !== existing.stripeProductId) ||
          (data.stripePriceId !== undefined && data.stripePriceId !== existing.stripePriceId);
        const requiresServiceValidation = pricingChanged || poolsChanged ||
          effectiveServiceId !== existing.serviceId ||
          (data.active === true && !existing.active);
        let syncPools = false;
        // Deactivation and presentation-only edits must work during a provider outage.
        // Actual pricing/mode changes and activation still validate the effective service,
        // even when its ID is unchanged. The rate schema is always validated above.
        if (requiresServiceValidation) {
          if (!effectiveServiceId) {
            return NextResponse.json({ error: "HAI Service is required" }, { status: 400 });
          }
          const result = await validateServiceForProduct(effectiveServiceId, pricing.data.billingType, pools.data, id);
          if ("error" in result) {
            return NextResponse.json({ error: result.error }, { status: 400 });
          }
          syncPools = poolsChanged && result.service.service_type === "pod_accelerator" &&
            (pricing.data.billingType === "monthly" || pools.data.length > 0);
        }

        const updateData: Record<string, unknown> = { updatedBy: adminEmail };
        if (data.name !== undefined) updateData.name = data.name;
        if (data.description !== undefined) updateData.description = data.description || null;
        if (data.billingType !== undefined) updateData.billingType = data.billingType;
        if (data.pricePerHourCents !== undefined) updateData.pricePerHourCents = data.pricePerHourCents;
        if (data.pricePerMonthCents !== undefined) updateData.pricePerMonthCents = data.pricePerMonthCents;
        if (data.configurationPricing !== undefined) {
          updateData.configurationPricing = pricing.data.configurationPricing ?? Prisma.DbNull;
        }
        if (data.stripeProductId !== undefined) updateData.stripeProductId = data.stripeProductId;
        if (data.stripePriceId !== undefined) updateData.stripePriceId = data.stripePriceId;
        if (data.poolIds !== undefined) updateData.poolIds = JSON.stringify(data.poolIds);
        if (data.displayOrder !== undefined) updateData.displayOrder = data.displayOrder;
        if (data.active !== undefined) updateData.active = data.active;
        if (data.featured !== undefined) updateData.featured = data.featured;
        if (data.badgeText !== undefined) updateData.badgeText = data.badgeText || null;
        if (data.vramGb !== undefined) updateData.vramGb = data.vramGb || null;
        if (data.cudaCores !== undefined) updateData.cudaCores = data.cudaCores || null;
        if (data.gpuFamily !== undefined) updateData.gpuFamily = data.gpuFamily || null;
        if (data.serviceId !== undefined) updateData.serviceId = data.serviceId || null;

        // Many-to-many categories: use `set` to replace all connections
        if (data.categoryIds !== undefined) {
          updateData.categories = { set: data.categoryIds.map(cid => ({ id: cid })) };
        }

        const product = await prisma.gpuProduct.update({
          where: { id },
          data: updateData,
          include: { categories: { select: { id: true } } },
        });

        // Price-only edits must not mutate upstream provisioning configuration.
        const newCategoryIds = data.categoryIds ?? existingCategoryIds;
        const categoriesChanged = effectiveServiceId !== existing.serviceId ||
          (data.categoryIds !== undefined &&
            (newCategoryIds.length !== existingCategoryIds.length ||
              newCategoryIds.some(categoryId => !existingCategoryIds.includes(categoryId))));

        if (effectiveServiceId && (syncPools || categoriesChanged)) {
          try {
            clearCache(`/service/${effectiveServiceId}`);

            // Build the update payload — one object, one PUT
            const serviceUpdate: Record<string, unknown> = {};

            if (syncPools) {
              serviceUpdate.gpu_config = { default_gpu_pools: data.poolIds };
            }

            if (categoriesChanged) {
              const allCategoryScenarioIds = (await prisma.gpuCategory.findMany({
                where: { scenarioId: { not: null } },
                select: { scenarioId: true },
              })).map(c => c.scenarioId!);
              const svc = await getHAIService(effectiveServiceId);
              const existingScenarios: string[] = Array.isArray(svc.scenarios) ? svc.scenarios as string[] : [];
              const nonCategoryScenarios = existingScenarios.filter(s => !allCategoryScenarioIds.includes(s));
              const cats = newCategoryIds.length > 0
                ? await prisma.gpuCategory.findMany({
                    where: { id: { in: newCategoryIds } },
                    select: { scenarioId: true },
                  })
                : [];
              const categoryScenarioIds = cats.filter(c => c.scenarioId).map(c => c.scenarioId!);
              serviceUpdate.scenarios = [...new Set([...nonCategoryScenarios, ...categoryScenarioIds])];
            }

            clearCache(`/service/${effectiveServiceId}`);
            await updateHAIService(effectiveServiceId, serviceUpdate);
            console.log(`[Admin] HAI service ${effectiveServiceId} synced successfully`);
          } catch (err) {
            console.error("[Admin] HAI service sync failed:", err);
          }
        }

        return NextResponse.json({
          success: true,
          data: {
            ...product,
            poolIds: JSON.parse(product.poolIds),
            categoryIds: product.categories.map((c: { id: string }) => c.id),
          },
        });
      }

      case "delete": {
        if (!id) {
          return NextResponse.json({ error: "Product ID is required" }, { status: 400 });
        }

        await prisma.gpuProduct.delete({ where: { id } });
        return NextResponse.json({ success: true });
      }

      // ============================================
      // Category CRUD
      // ============================================

      case "create-category": {
        const { name: catName, slug: catSlug, description: catDesc, displayOrder: catOrder, active: catActive } =
          body as { name?: string; slug?: string; description?: string; displayOrder?: number; active?: boolean };

        if (!catName) {
          return NextResponse.json({ error: "Category name is required" }, { status: 400 });
        }

        // Auto-generate slug from name if not provided
        const slug = catSlug || catName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

        // Create HAI scenario for this category (required — fail if HAI is unreachable)
        const scenarioId = await createCategoryScenario(catName, slug);
        if (!scenarioId) {
          return NextResponse.json({ error: "Failed to create HAI scenario for this category. Check HAI connectivity and try again." }, { status: 502 });
        }

        const category = await prisma.gpuCategory.create({
          data: {
            name: catName,
            slug,
            description: catDesc || null,
            scenarioId,
            displayOrder: catOrder || 0,
            active: catActive ?? true,
          },
        });

        console.log(`[Admin] Created GPU category: ${category.name} (scenario: ${scenarioId || "pending"})`);
        return NextResponse.json({ success: true, data: category });
      }

      case "update-category": {
        if (!id) {
          return NextResponse.json({ error: "Category ID is required" }, { status: 400 });
        }

        const existing = await prisma.gpuCategory.findUnique({ where: { id } });
        if (!existing) {
          return NextResponse.json({ error: "Category not found" }, { status: 404 });
        }

        const catUpdateData: Record<string, unknown> = {};
        if (body.name !== undefined) catUpdateData.name = body.name;
        if (body.slug !== undefined) catUpdateData.slug = body.slug;
        if (body.description !== undefined) catUpdateData.description = body.description || null;
        if (body.displayOrder !== undefined) catUpdateData.displayOrder = body.displayOrder;
        if (body.active !== undefined) catUpdateData.active = body.active;
        if (body.icon !== undefined) catUpdateData.icon = body.icon || null;

        // Retry scenario creation if previously failed
        if (!existing.scenarioId) {
          const scenarioId = await createCategoryScenario(
            (body.name as string) || existing.name,
            (body.slug as string) || existing.slug
          );
          if (scenarioId) {
            catUpdateData.scenarioId = scenarioId;
          }
        }

        const category = await prisma.gpuCategory.update({
          where: { id },
          data: catUpdateData,
        });

        return NextResponse.json({ success: true, data: category });
      }

      case "delete-category": {
        if (!id) {
          return NextResponse.json({ error: "Category ID is required" }, { status: 400 });
        }

        // Prisma onDelete: Restrict will throw if products exist
        await prisma.gpuCategory.delete({ where: { id } });
        return NextResponse.json({ success: true });
      }

      case "list-categories": {
        const categories = await prisma.gpuCategory.findMany({
          orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
          include: { _count: { select: { products: true } } },
        });
        return NextResponse.json({ success: true, data: categories });
      }

      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (err) {
    console.error("GPU Products POST error:", err);
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json({ error: "A product or category with this name already exists" }, { status: 400 });
    }
    if (err instanceof Error && err.message.includes("Foreign key constraint")) {
      return NextResponse.json({ error: "Cannot delete category that has products. Move or delete the products first." }, { status: 400 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
