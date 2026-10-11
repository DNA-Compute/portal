/**
 * GPU Apps Status API - Get installation status
 *
 * GET /api/apps/status?subscriptionId=123&appSlug=jupyter-pytorch&verify=true
 *
 * When verify=true, actually checks if the app is running on the pod via SSH
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyCustomerToken } from "@/lib/auth";
import { gatePermission } from "@/lib/auth/gate";
import { resolveOperatingContext } from "@/lib/auth/account-resolver";
import { getInstanceCredentials, sshLoginFromCredentials } from "@/lib/hostedai";
import { canonicalInstanceId, ownsInstance } from "@/lib/auth/instance-ownership";
import { getOrCreateServerSSHKey, executeSSHWithKey } from "@/lib/ssh-keys";

// Check if a port is listening on the pod via SSH
async function verifyAppRunning(
  host: string,
  port: number,
  username: string,
  privateKeyPath: string,
  appPort: number
): Promise<boolean> {
  try {
    // Check if something is listening on the app's port
    const result = await executeSSHWithKey(
      host,
      port,
      username,
      privateKeyPath,
      `ss -tlnp 2>/dev/null | grep -q ":${appPort} " && echo "RUNNING" || echo "NOT_RUNNING"`,
      10000 // 10 second timeout
    );
    return result.success && result.output.includes("RUNNING");
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await verifyCustomerToken(token);
  if (!payload) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  // PA-175: scope to operating account.
  const ctx = await resolveOperatingContext({
    email: payload.email,
    jwtCustomerId: payload.customerId,
    activeAccountId: payload.activeAccountId,
  });
  if (!ctx) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  const accountId = ctx.accountId;

  // PA-202 gate: Apps hidden from Read-only Member + Finance Manager.
  const denial = await gatePermission({
    payload,
    accountId,
    customerEmail: typeof ctx.customer.email === "string" ? ctx.customer.email : null,
    permission: "apps.use",
    request,
  });
  if (denial) return denial;

  const subscriptionId = request.nextUrl.searchParams.get("subscriptionId");
  const appSlug = request.nextUrl.searchParams.get("appSlug");
  const shouldVerify = request.nextUrl.searchParams.get("verify") === "true";

  if (!subscriptionId) {
    return NextResponse.json({ error: "subscriptionId is required" }, { status: 400 });
  }

  // Get installations for this subscription
  const where: { subscriptionId: string; stripeCustomerId: string; app?: { slug: string } } = {
    subscriptionId,
    stripeCustomerId: accountId,
  };

  if (appSlug) {
    where.app = { slug: appSlug };
  }

  const installations = await prisma.installedApp.findMany({
    where,
    include: {
      app: {
        select: {
          slug: true,
          name: true,
          icon: true,
          defaultPort: true,
          webUiPort: true,
          serviceType: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // If verify=true, actually check if apps are running
  let sshInfo: { host: string; port: number; username: string; privateKeyPath: string } | null = null;

  if (shouldVerify && installations.some(i => i.status === "running")) {
    try {
      // Install rows from before installs checked ownership could name another customer's GPU.
      const login = (await ownsInstance(ctx.allTeamIds, subscriptionId))
        ? sshLoginFromCredentials(await getInstanceCredentials(canonicalInstanceId(subscriptionId)))
        : null;
      if (login) {
        const { privateKeyPath } = await getOrCreateServerSSHKey();
        sshInfo = { host: login.host, port: login.port, username: login.username, privateKeyPath };
      }
    } catch (err) {
      console.error("[AppStatus] Error getting SSH info for verification:", err);
    }
  }

  const apps = await Promise.all(installations.map(async (i) => {
    let status = i.status;
    let verified = false;

    // If we have SSH info and app claims to be running, verify it
    if (sshInfo && i.status === "running" && i.port) {
      const isActuallyRunning = await verifyAppRunning(
        sshInfo.host,
        sshInfo.port,
        sshInfo.username,
        sshInfo.privateKeyPath,
        i.port
      );

      verified = true;

      if (!isActuallyRunning) {
        // App is not actually running - mark it as stopped
        status = "stopped";
        // Update the database
        await prisma.installedApp.update({
          where: { id: i.id },
          data: { status: "stopped" },
        });
      }
    }

    return {
      id: i.id,
      appSlug: i.app.slug,
      appName: i.app.name,
      appIcon: i.app.icon,
      status,
      verified, // Include whether we actually verified via SSH
      installProgress: i.installProgress,
      installOutput: i.installOutput,
      errorMessage: i.errorMessage,
      port: i.port || i.app.defaultPort,
      webUiPort: i.webUiPort || i.app.webUiPort,
      serviceType: i.app.serviceType,
      externalUrl: i.externalUrl,
      webUiUrl: i.webUiUrl,
      startedAt: i.startedAt,
      createdAt: i.createdAt,
    };
  }));

  return NextResponse.json({ apps });
}
