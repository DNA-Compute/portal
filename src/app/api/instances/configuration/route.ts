import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import { requirePermission } from "@/lib/auth/audit";
import { getLaunchCapabilities, LaunchCapabilityError } from "@/lib/launch-capabilities";

const identifier = z.string().trim().min(1).max(256);
const querySchema = z.object({
  product_id: identifier,
  region_id: z.coerce.number().int().positive().optional(),
  pool_id: z.coerce.number().int().positive().optional(),
  gpu_model_id: identifier.optional(),
  gpu_count: z.coerce.number().int().min(1).max(256).optional(),
  image_hash: identifier.optional(),
  instance_type_id: identifier.optional(),
}).strict();

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedCustomer(request);
  if (auth instanceof NextResponse) return auth;
  const denial = requirePermission(auth, "gpu.provision", request);
  if (denial) return denial;
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid configuration selection.", details: parsed.error.flatten() }, { status: 400 });
  try {
    const query = parsed.data;
    const capabilities = await getLaunchCapabilities(auth, query.product_id, query.region_id, query.pool_id, query.gpu_model_id, {
      gpuCount: query.gpu_count, imageHash: query.image_hash, instanceTypeId: query.instance_type_id,
    });
    return NextResponse.json({ capabilities });
  } catch (error) {
    if (error instanceof LaunchCapabilityError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    console.error("[Launch configuration] Failed to discover capabilities", error);
    return NextResponse.json({ error: "Unable to load this GPU configuration. Please retry." }, { status: 500 });
  }
}
