import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import { forbidden } from "@/lib/auth/audit";
import { prisma } from "@/lib/prisma";

// GET /api/account/settings - Get customer settings
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedCustomer(request);
    if (auth instanceof NextResponse) return auth;

    // Get or create settings for this customer
    let settings = await prisma.customerSettings.findUnique({
      where: { stripeCustomerId: auth.accountId },
    });

    if (!settings) {
      settings = await prisma.customerSettings.create({
        data: {
          stripeCustomerId: auth.accountId,
          sessionTimeoutHours: 1, // Default 1 hour
        },
      });
    }

    return NextResponse.json({
      success: true,
      settings: {
        sessionTimeoutHours: settings.sessionTimeoutHours,
      },
    });
  } catch (error) {
    console.error("Failed to get customer settings:", error);
    return NextResponse.json(
      { success: false, error: "Failed to get settings" },
      { status: 500 }
    );
  }
}

// PUT /api/account/settings - Update customer settings
export async function PUT(request: NextRequest) {
  try {
    const auth = await getAuthenticatedCustomer(request);
    if (auth instanceof NextResponse) return auth;
    // How long login links last applies to everyone on the account.
    if (!auth.can("team.manage")) return forbidden(auth, "team.manage", request);

    const body = await request.json();
    const { sessionTimeoutHours } = body;

    // Validate session timeout (1-24 hours)
    if (
      typeof sessionTimeoutHours !== "number" ||
      sessionTimeoutHours < 1 ||
      sessionTimeoutHours > 24
    ) {
      return NextResponse.json(
        { success: false, error: "Session timeout must be between 1 and 24 hours" },
        { status: 400 }
      );
    }

    // Upsert settings
    const settings = await prisma.customerSettings.upsert({
      where: { stripeCustomerId: auth.accountId },
      update: { sessionTimeoutHours },
      create: {
        stripeCustomerId: auth.accountId,
        sessionTimeoutHours,
      },
    });

    return NextResponse.json({
      success: true,
      settings: {
        sessionTimeoutHours: settings.sessionTimeoutHours,
      },
    });
  } catch (error) {
    console.error("Failed to update customer settings:", error);
    return NextResponse.json(
      { success: false, error: "Failed to update settings" },
      { status: 500 }
    );
  }
}
