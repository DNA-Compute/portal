import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken } from "@/lib/customer-auth";
import { instanceProductName, logGPUTerminated } from "@/lib/activity";
import { prisma } from "@/lib/prisma";
import { sendGpuTerminatedEmail } from "@/lib/email";
import { generateCustomerToken } from "@/lib/customer-auth";
import { cacheCustomer } from "@/lib/customer-cache";
import { gatePermission } from "@/lib/auth/gate";
import { resolveOperatingContext } from "@/lib/auth/account-resolver";
import { rejectUnownedInstance } from "@/lib/auth/instance-ownership";
import { isInstanceId, terminateGpu, TerminationError } from "@/lib/gpu-termination";

// GET - Get pod metadata (display name, notes)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = verifyCustomerToken(token);
    if (!payload) {
      return NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 401 }
      );
    }

    const { id } = await params;
    const ctx = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });
    if (!ctx) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    const notOwned = await rejectUnownedInstance(ctx.allTeamIds, id);
    if (notOwned) return notOwned;

    // Look up by instanceId (HAI 2.2) or subscriptionId (legacy)
    const metadata = isInstanceId(id)
      ? await prisma.podMetadata.findFirst({ where: { instanceId: id } })
      : await prisma.podMetadata.findUnique({ where: { subscriptionId: id } });

    return NextResponse.json({
      subscriptionId: isInstanceId(id) ? metadata?.subscriptionId : id,
      instanceId: isInstanceId(id) ? id : metadata?.instanceId,
      displayName: metadata?.displayName || null,
      notes: metadata?.notes || null,
    });
  } catch (error) {
    console.error("Get pod metadata error:", error);
    return NextResponse.json(
      { error: "Failed to get pod metadata" },
      { status: 500 }
    );
  }
}

// PATCH - Update pod metadata (display name, notes)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = verifyCustomerToken(token);
    if (!payload) {
      return NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 401 }
      );
    }

    const { id } = await params;
    const { displayName, notes } = await request.json();

    if (displayName !== undefined && typeof displayName !== "string") {
      return NextResponse.json(
        { error: "displayName must be a string" },
        { status: 400 }
      );
    }
    if (notes !== undefined && typeof notes !== "string") {
      return NextResponse.json(
        { error: "notes must be a string" },
        { status: 400 }
      );
    }

    const ctx = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });
    if (!ctx) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    const notOwned = await rejectUnownedInstance(ctx.allTeamIds, id);
    if (notOwned) return notOwned;

    // HAI 2.2: look up by instanceId, then upsert
    if (isInstanceId(id)) {
      const existing = await prisma.podMetadata.findFirst({ where: { instanceId: id } });
      if (existing) {
        const updated = await prisma.podMetadata.update({
          where: { id: existing.id },
          data: {
            ...(displayName !== undefined && { displayName: displayName || null }),
            ...(notes !== undefined && { notes: notes || null }),
          },
        });
        return NextResponse.json({
          success: true,
          instanceId: id,
          displayName: updated.displayName,
          notes: updated.notes,
        });
      }
    }

    // Legacy: upsert by subscriptionId. PA-175: scope create to operating
    // account so an invited Member writing metadata on a team pod doesn't
    // create a rogue row attributed to their own customer.
    const metadata = await prisma.podMetadata.upsert({
      where: { subscriptionId: id },
      update: {
        ...(displayName !== undefined && { displayName: displayName || null }),
        ...(notes !== undefined && { notes: notes || null }),
      },
      create: {
        subscriptionId: id,
        stripeCustomerId: ctx.accountId,
        displayName: displayName || null,
        notes: notes || null,
      },
    });

    return NextResponse.json({
      success: true,
      subscriptionId: id,
      displayName: metadata.displayName,
      notes: metadata.notes,
    });
  } catch (error) {
    console.error("Update pod metadata error:", error);
    return NextResponse.json(
      { error: "Failed to update pod metadata" },
      { status: 500 }
    );
  }
}

// DELETE - Unsubscribe from a pool (terminate)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const token = request.headers.get("authorization")?.replace("Bearer ", "");

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = verifyCustomerToken(token);
    if (!payload) {
      return NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 401 }
      );
    }

    // PA-175: resolve the OPERATING account. An invited Team Admin / Member
    // terminating a team pod must hit the team owner's wallet for refund,
    // not their own.
    const ctx = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });
    if (!ctx) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }
    const customer = ctx.customer;
    cacheCustomer(customer).catch(() => {});

    const teamId = customer.metadata?.hostedai_team_id;
    if (!teamId) {
      return NextResponse.json(
        { error: "No team associated with this account" },
        { status: 400 }
      );
    }

    const { id } = await params;

    // PA-175 gate: terminating a pool subscription / unified instance requires gpu.terminate
    // on the OPERATING team.
    const denial = await gatePermission({
      payload,
      accountId: ctx.accountId,
      customerEmail: typeof customer.email === "string" ? customer.email : null,
      permission: "gpu.terminate",
      request,
      extra: { id },
    });
    if (denial) return denial;

    // The refund below credits the caller, so this must run before any billing or deletion.
    const notOwned = await rejectUnownedInstance(ctx.allTeamIds, id);
    if (notOwned) return notOwned;

    // Stop the GPU first, then settle once, then forget it (see terminateGpu).
    let ended;
    try {
      ended = await terminateGpu(id, teamId);
    } catch (error) {
      if (error instanceof TerminationError) {
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
      }
      throw error;
    }

    await logGPUTerminated(ctx.accountId, await instanceProductName(ended.productId), ended.displayName, ended.instanceId);

    try {
      const dashboardToken = generateCustomerToken(payload.email.toLowerCase(), payload.customerId);
      const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?token=${dashboardToken}`;
      await sendGpuTerminatedEmail({
        to: customer.email!,
        customerName: customer.name || customer.email!.split("@")[0],
        poolName: ended.displayName || "GPU Instance",
        dashboardUrl,
      });
    } catch (emailErr) {
      console.error("Failed to send GPU terminated email:", emailErr);
    }

    return NextResponse.json({ success: true, message: "Instance deleted successfully" });
  } catch (error) {
    console.error("Unsubscribe error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to unsubscribe" },
      { status: 500 }
    );
  }
}
