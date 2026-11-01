import { NextRequest, NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get("session_id");

  if (!sessionId) {
    return NextResponse.json(
      { error: "session_id is required" },
      { status: 400 }
    );
  }

  try {
    const stripe = await getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (!session || !session.customer_email) {
      return NextResponse.json({ ready: false });
    }

    const customerId = session.customer as string | null;
    if (!customerId) {
      return NextResponse.json({ ready: false });
    }

    const customer = await stripe.customers.retrieve(customerId);
    if ("deleted" in customer && customer.deleted) {
      return NextResponse.json({ ready: false });
    }

    // Standard path: this Stripe customer owns a hosted.ai team (new-user signup,
    // hourly or first-time monthly).
    let teamId = customer.metadata?.hostedai_team_id;

    // Existing-user monthly path: the monthly subscription creates a separate
    // Stripe customer that does NOT carry hostedai_team_id. Instead the webhook
    // sets primary_stripe_customer_id pointing at the primary (hourly) customer
    // that owns the team. Follow that link.
    if (!teamId && customer.metadata?.primary_stripe_customer_id) {
      const primaryId = customer.metadata.primary_stripe_customer_id;
      const primary = await stripe.customers.retrieve(primaryId);
      if (!("deleted" in primary && primary.deleted)) {
        const primaryTeamId = primary.metadata?.hostedai_team_id;
        if (primaryTeamId) {
          teamId = primaryTeamId;
        }
      }
    }

    if (!teamId) {
      return NextResponse.json({ ready: false });
    }

    // Account is ready. No login here: whoever holds this session id only proved they paid, not
    // that they own the email, and the account may be an existing one linked by email. The
    // welcome email carries the login link, so only the inbox owner gets in.
    return NextResponse.json({
      ready: true,
      email: session.customer_email,
      amountCents: session.amount_total || 0,
    });
  } catch (error) {
    console.error("Check-ready error:", error);
    return NextResponse.json({ ready: false });
  }
}
