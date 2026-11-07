import { describe, it, expect, vi } from "vitest";

// A customer with several GPUs needs to know which one started, as the terminated email already says.

const sent = vi.hoisted(() => [] as Array<{ subject: string; html: string; text: string }>);
vi.mock("@/lib/email/client", () => ({ sendEmail: vi.fn(async (email: { subject: string; html: string; text: string }) => { sent.push(email); }) }));
vi.mock("@/lib/email/template-loader", () => ({ loadTemplate: vi.fn(async (_slug: string, _vars: unknown, fallback: unknown) => fallback) }));

import { sendGpuLaunchedEmail } from "@/lib/email/templates/gpu-events";

describe("GPU started email", () => {
  it("names the instance in the subject, body and text", async () => {
    await sendGpuLaunchedEmail({
      to: "customer@example.com", customerName: "Ada", instanceName: "billing-<test>",
      poolName: "H100 fractional", gpuCount: 1, gpuSharePercent: 25, dashboardUrl: "https://example.com/dashboard",
    });
    const email = sent.at(-1)!;
    expect(email.subject).toBe("GPU instance started: billing-<test> (25% GPU share on H100 fractional)");
    expect(email.html).toContain("GPU Instance Started: billing-&lt;test&gt;");
    expect(email.text).toContain("GPU Instance Started: billing-<test>");
  });
});
