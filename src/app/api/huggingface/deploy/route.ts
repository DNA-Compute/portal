import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import { requirePermission } from "@/lib/auth/audit";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/huggingface/deploy
 *
 * List all HuggingFace deployments for the current user
 */
export async function GET(request: NextRequest) {
  try {
    // PA-175: use getAuthenticatedCustomer so the gate runs against the
    // OPERATING account (invited Members on a switched-into team work).
    const auth = await getAuthenticatedCustomer(request);
    if (auth instanceof NextResponse) return auth;
    const { accountId } = auth;

    // PA-202 gate: Hugging Face hidden from Read-only Member + Finance Manager.
    const denial = requirePermission(auth, "huggingface.use", request);
    if (denial) return denial;

    const deployments = await prisma.huggingFaceDeployment.findMany({
      where: {
        stripeCustomerId: accountId,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json({
      deployments: deployments.map((d) => ({
        id: d.id,
        subscriptionId: d.subscriptionId,
        hfItemId: d.hfItemId,
        hfItemName: d.hfItemName,
        hfItemType: d.hfItemType,
        deployScript: d.deployScript,
        status: d.status,
        servicePort: d.servicePort,
        openWebUI: d.openWebUI,
        webUiPort: d.webUiPort,
        netdata: d.netdata,
        netdataPort: d.netdataPort,
        errorMessage: d.errorMessage,
        createdAt: d.createdAt.toISOString(),
        updatedAt: d.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("Get deployments error:", error);
    return NextResponse.json(
      { error: "Failed to get deployments" },
      { status: 500 }
    );
  }
}
