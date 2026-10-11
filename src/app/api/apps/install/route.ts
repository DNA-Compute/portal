/**
 * GPU Apps Install API - Install an app on a pod via SSH
 *
 * POST /api/apps/install
 * Body: { subscriptionId: string, appSlug: string }
 */

import { NextRequest, NextResponse } from "next/server";
import { getAppBySlug } from "@/lib/gpu-apps";
import { prisma } from "@/lib/prisma";
import { verifyCustomerToken } from "@/lib/auth";
import { gatePermission } from "@/lib/auth/gate";
import { resolveOperatingContext } from "@/lib/auth/account-resolver";
import { canonicalInstanceId, rejectUnownedInstance } from "@/lib/auth/instance-ownership";
import { getInstanceCredentials, sshLoginFromCredentials } from "@/lib/hostedai";
import { spawn } from "child_process";
import { getOrCreateServerSSHKey, executeSSHWithKey } from "@/lib/ssh-keys";
import { validateSSHParams } from "@/lib/ssh-validation";

/**
 * Execute SSH command on a pod using password auth (for key injection)
 */
async function executeSSHCommandWithPassword(
  host: string,
  port: number,
  username: string,
  password: string,
  command: string,
  timeoutMs: number = 60000 // 1 minute default for key injection
): Promise<{ success: boolean; output: string; exitCode: number }> {
  // Validate SSH parameters to prevent command injection
  validateSSHParams({ host, port, username });

  return new Promise((resolve) => {
    // Pass script via stdin ("bash -s") to avoid script text in SSH command line
    const args = [
      "-e",
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=20",
      "-o", "TCPKeepAlive=yes",
      "-p", String(port),
      `${username}@${host}`,
      "bash -s",
    ];

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const proc = spawn("sshpass", args, {
      timeout: timeoutMs,
      env: { ...process.env, SSHPASS: password },
    });

    // Write the script to stdin
    proc.stdin.write(command);
    proc.stdin.end();

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        resolve({
          success: code === 0,
          output: stdout + (stderr ? `\n${stderr}` : ""),
          exitCode: code || 0,
        });
      }
    });

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        resolve({
          success: false,
          output: `Error: ${err.message}`,
          exitCode: -1,
        });
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        resolve({
          success: false,
          output: "Command timed out after " + (timeoutMs / 1000) + " seconds",
          exitCode: -2,
        });
      }
    }, timeoutMs);
  });
}

/**
 * Inject server SSH public key into pod's authorized_keys
 */
async function injectSSHKey(
  host: string,
  port: number,
  username: string,
  password: string,
  publicKey: string
): Promise<{ success: boolean; error?: string }> {
  // Command to add key to authorized_keys if not already present
  const keyContent = publicKey.trim();
  const command = `
    mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
    touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && \
    if ! grep -qF "${keyContent}" ~/.ssh/authorized_keys 2>/dev/null; then \
      echo "${keyContent}" >> ~/.ssh/authorized_keys && echo "KEY_ADDED"; \
    else \
      echo "KEY_EXISTS"; \
    fi
  `.trim();

  const result = await executeSSHCommandWithPassword(host, port, username, password, command);

  if (!result.success) {
    return { success: false, error: `Failed to inject SSH key: ${result.output}` };
  }

  return { success: true };
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await verifyCustomerToken(token);
  if (!payload) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  // PA-175: scope to operating account (team owner's customer when invited).
  const ctx = await resolveOperatingContext({
    email: payload.email,
    jwtCustomerId: payload.customerId,
    activeAccountId: payload.activeAccountId,
  });
  if (!ctx) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  const accountId = ctx.accountId;
  const customer = ctx.customer;

  // PA-202 gate: Apps hidden from Read-only Member + Finance Manager.
  const denial = await gatePermission({
    payload,
    accountId,
    customerEmail: typeof customer.email === "string" ? customer.email : null,
    permission: "apps.use",
    request,
  });
  if (denial) return denial;

  const body = await request.json();
  const { subscriptionId, appSlug } = body;

  if (!subscriptionId || !appSlug) {
    return NextResponse.json(
      { error: "subscriptionId and appSlug are required" },
      { status: 400 }
    );
  }

  // Get app definition
  const app = getAppBySlug(appSlug);
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  const teamId = customer.metadata?.hostedai_team_id;

  if (!teamId) {
    return NextResponse.json(
      { error: "No team associated with this account" },
      { status: 400 }
    );
  }

  // hosted.ai's team filter on a single subscription has leaked other teams' rows, so check here first.
  const notOwned = await rejectUnownedInstance(ctx.allTeamIds, subscriptionId);
  if (notOwned) return notOwned;

  // Check if app is already installed
  const existingInstall = await prisma.installedApp.findFirst({
    where: {
      subscriptionId,
      app: { slug: appSlug },
      status: { notIn: ["uninstalled", "failed"] },
    },
  });

  if (existingInstall) {
    return NextResponse.json(
      { error: "App is already installed or installing", status: existingInstall.status },
      { status: 400 }
    );
  }

  let login;
  try {
    login = sshLoginFromCredentials(await getInstanceCredentials(canonicalInstanceId(subscriptionId)));
  } catch (error) {
    console.error("[AppInstall] Could not fetch the instance's SSH login:", error);
    return NextResponse.json(
      { error: "Could not reach the GPU provider to connect to this GPU. Try again in a minute." },
      { status: 502 }
    );
  }
  if (!login) {
    return NextResponse.json(
      { error: "SSH is not ready on this GPU yet. Try again in a minute." },
      { status: 409 }
    );
  }

  // Get or create the app in database
  let dbApp = await prisma.gpuApp.findUnique({ where: { slug: appSlug } });
  if (!dbApp) {
    dbApp = await prisma.gpuApp.create({
      data: {
        slug: app.slug,
        name: app.name,
        description: app.description,
        longDescription: app.longDescription,
        category: app.category,
        installScript: app.slug, // Reference to the script
        estimatedInstallMin: app.estimatedInstallMin,
        minVramGb: app.minVramGb,
        recommendedVramGb: app.recommendedVramGb,
        typicalVramUsageGb: app.typicalVramUsageGb,
        defaultPort: app.defaultPort,
        webUiPort: app.webUiPort,
        serviceType: app.serviceType,
        icon: app.icon,
        badgeText: app.badgeText,
        displayOrder: app.displayOrder,
        tags: JSON.stringify(app.tags),
        docsUrl: app.docsUrl,
      },
    });
  }

  // Create installation record
  const installation = await prisma.installedApp.create({
    data: {
      subscriptionId,
      stripeCustomerId: accountId,
      appId: dbApp.id,
      status: "installing",
      installProgress: 0,
    },
  });

  const { host, port, username, password } = login;

  // Start installation in background
  (async () => {
    try {
      console.log(`[AppInstall] Starting ${appSlug} on ${host}:${port} (sub: ${subscriptionId})`);
      console.log(`[AppInstall] Script length: ${app.installScript.length} chars`);

      // Update progress
      await prisma.installedApp.update({
        where: { id: installation.id },
        data: { installProgress: 5, installOutput: "Getting server SSH key..." },
      });

      // Step 1: Get or create server SSH key
      const { publicKey, privateKeyPath } = await getOrCreateServerSSHKey();
      console.log(`[AppInstall] SSH key ready, injecting into pod...`);

      await prisma.installedApp.update({
        where: { id: installation.id },
        data: { installProgress: 10, installOutput: "Injecting SSH key into pod..." },
      });

      // Step 2: Inject the public key into the pod using password auth (one-time)
      const keyInjection = await injectSSHKey(host, port, username, password, publicKey);
      if (!keyInjection.success) {
        // Fall back to password-based install if key injection fails
        console.warn(`[AppInstall] Key injection failed, falling back to password auth: ${keyInjection.error}`);
        await prisma.installedApp.update({
          where: { id: installation.id },
          data: { installProgress: 15, installOutput: "Connecting to pod (fallback mode)..." },
        });

        // Use password-based SSH for install
        const result = await executeSSHCommandWithPassword(
          host,
          port,
          username,
          password,
          app.installScript,
          app.estimatedInstallMin * 60 * 1000 * 2
        );

        console.log(`[AppInstall] Password-auth result: exit=${result.exitCode}, output=${result.output.slice(0, 500)}`);

        if (result.success) {
          const portMatch = result.output.match(/PORT=(\d+)/);
          const installedPort = portMatch ? parseInt(portMatch[1], 10) : app.defaultPort;

          await prisma.installedApp.update({
            where: { id: installation.id },
            data: {
              status: "running",
              installProgress: 100,
              installOutput: result.output,
              port: installedPort,
              webUiPort: app.webUiPort,
              startedAt: new Date(),
            },
          });
        } else {
          await prisma.installedApp.update({
            where: { id: installation.id },
            data: {
              status: "failed",
              installProgress: 0,
              installOutput: result.output,
              errorMessage: `Installation failed with exit code ${result.exitCode}`,
            },
          });
        }
        return;
      }

      console.log(`[AppInstall] Key injected, running install script via key auth...`);
      await prisma.installedApp.update({
        where: { id: installation.id },
        data: { installProgress: 20, installOutput: "Running install script..." },
      });

      // Step 3: Execute install script using key-based SSH (more reliable for long-running commands)
      const result = await executeSSHWithKey(
        host,
        port,
        username,
        privateKeyPath,
        app.installScript,
        app.estimatedInstallMin * 60 * 1000 * 2 // Double the estimate for safety
      );

      console.log(`[AppInstall] Key-auth result: exit=${result.exitCode}, output=${result.output.slice(0, 500)}`);

      if (result.success) {
        // Parse output for port info
        const portMatch = result.output.match(/PORT=(\d+)/);
        const installedPort = portMatch ? parseInt(portMatch[1], 10) : app.defaultPort;

        await prisma.installedApp.update({
          where: { id: installation.id },
          data: {
            status: "running",
            installProgress: 100,
            installOutput: result.output,
            port: installedPort,
            webUiPort: app.webUiPort,
            startedAt: new Date(),
          },
        });
      } else {
        await prisma.installedApp.update({
          where: { id: installation.id },
          data: {
            status: "failed",
            installProgress: 0,
            installOutput: result.output,
            errorMessage: `Installation failed with exit code ${result.exitCode}`,
          },
        });
      }
    } catch (error) {
      console.error(`[AppInstall] Exception:`, error);
      await prisma.installedApp.update({
        where: { id: installation.id },
        data: {
          status: "failed",
          errorMessage: error instanceof Error ? error.message : "Unknown error",
        },
      });
    }
  })();

  return NextResponse.json({
    success: true,
    installationId: installation.id,
    message: `Installing ${app.name}... This may take ${app.estimatedInstallMin} minutes.`,
  });
}
