import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedCustomer } from "@/lib/auth/helpers";
import { forbidden } from "@/lib/auth/audit";
import { launchConfigurationSchema } from "@/lib/launch-config";
import { resolveAndQuoteLaunch } from "@/lib/launch-quote";

const requestSchema = z.object({ configuration: launchConfigurationSchema }).strict();

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedCustomer(request);
    if (auth instanceof NextResponse) return auth;
    if (!auth.can("gpu.provision")) return forbidden(auth, "gpu.provision", request);
    const parsed = requestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Select a valid complete configuration before requesting its price." }, { status: 400 });
    }
    const { quote } = await resolveAndQuoteLaunch(auth, parsed.data.configuration);
    return NextResponse.json({ quote }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 });
    }
    if (error instanceof Error && "status" in error && typeof error.status === "number" && Number.isInteger(error.status) && error.status >= 400 && error.status < 600) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[Launch quote] Unable to resolve configuration", error instanceof Error ? error.name : "Unknown error");
    return NextResponse.json({ error: "Unable to obtain a current configuration price. Please try again." }, { status: 503 });
  }
}
