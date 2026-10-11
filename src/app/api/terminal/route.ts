import { NextRequest, NextResponse } from "next/server";
import { getInstanceCredentials } from "@/lib/hostedai";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import { requirePermission } from "@/lib/auth/audit";
import { canonicalInstanceId, rejectUnownedInstance } from "@/lib/auth/instance-ownership";
import jwt from "jsonwebtoken";

// GET - Generate a terminal session URL with credentials
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedCustomer(request);
    if (auth instanceof NextResponse) return auth;
    const { payload, allTeamIds } = auth;

    // The response carries the SSH password, so it needs the same gpu.access as connection-info.
    const denial = requirePermission(auth, "gpu.access", request);
    if (denial) return denial;

    if (!allTeamIds.length) {
      return NextResponse.json(
        { error: "No team associated with this account" },
        { status: 400 }
      );
    }

    // Get instance ID from query params
    const subscriptionId = canonicalInstanceId(request.nextUrl.searchParams.get("subscription_id"));
    if (!subscriptionId) {
      return NextResponse.json(
        { error: "subscription_id is required" },
        { status: 400 }
      );
    }

    const notOwned = await rejectUnownedInstance(allTeamIds, subscriptionId);
    if (notOwned) return notOwned;

    // Get SSH credentials via HAI 2.2 credentials API
    const creds = await getInstanceCredentials(subscriptionId);

    if (!creds.ip || !creds.port || !creds.username || !creds.password) {
      return NextResponse.json(
        { error: "No SSH connection available. Pod may not be running." },
        { status: 404 }
      );
    }

    const sshCredentials = {
      host: creds.ip,
      port: creds.port,
      username: creds.username,
      password: creds.password,
    };

    const wsSecret = process.env.ADMIN_JWT_SECRET;
    if (!wsSecret) {
      return NextResponse.json(
        { error: "Server configuration error" },
        { status: 500 }
      );
    }

    const wsToken = jwt.sign(
      {
        type: "ssh-session",
        ssh: sshCredentials,
        customerId: payload.customerId,
        subscriptionId,
      },
      wsSecret,
      { expiresIn: "2m", algorithm: "HS256" }
    );

    return NextResponse.json({
      host: creds.ip,
      port: creds.port,
      username: creds.username,
      password: creds.password,
      wsToken,
    });
  } catch (error) {
    console.error("Terminal session error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to get terminal session" },
      { status: 500 }
    );
  }
}
