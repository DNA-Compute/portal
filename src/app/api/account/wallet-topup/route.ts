import { NextRequest, NextResponse } from "next/server";
import { verifyCustomerToken, generateCustomerToken } from "@/lib/customer-auth";
import { getStripe } from "@/lib/stripe";
import { validateVoucher } from "@/lib/voucher";
import { gatePermission } from "@/lib/auth/gate";
import { resolveOperatingContext } from "@/lib/auth/account-resolver";
import { CUSTOM_TOP_UP, TOP_UP_AMOUNTS, isValidTopUpAmount } from "@/lib/wallet-topup";


export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = authHeader.substring(7);
  const payload = verifyCustomerToken(token);
  if (!payload) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  try {
    const { amount, voucherCode, launchProductId } = await request.json();

    // Validate amount
    const amountCents = Number(amount);
    if (!isValidTopUpAmount(amountCents)) {
      return NextResponse.json({
        error: `Enter a whole-dollar amount between $${CUSTOM_TOP_UP.minCents / 100} and $${(CUSTOM_TOP_UP.maxCents / 100).toLocaleString("en-US")}`,
      }, { status: 400 });
    }

    const stripe = await getStripe();

    const context = await resolveOperatingContext({
      email: payload.email,
      jwtCustomerId: payload.customerId,
      activeAccountId: payload.activeAccountId,
    });
    if (!context) return NextResponse.json({ error: "Account not found" }, { status: 404 });
    const customer = context.customer;

    // PA-175 gate: only Owner / Admin / Finance Manager can top up the wallet.
    const denial = await gatePermission({
      payload,
      accountId: customer.id,
      customerEmail: typeof customer.email === "string" ? customer.email : null,
      permission: "billing.manage",
      request,
    });
    if (denial) return denial;

    // NOTE: billing_type upgrade from free/free_trial to hourly now happens in the
    // Stripe webhook (handleWalletTopup) AFTER payment succeeds. This prevents
    // users from getting hourly billing status without actually paying.
    const bt = customer.metadata?.billing_type;
    if (bt !== "free" && bt !== "free_trial" && bt !== "hourly") {
      return NextResponse.json(
        { error: "Wallet top-up is only available for hourly billing customers" },
        { status: 400 }
      );
    }

    // Validate voucher code if provided
    let validatedVoucher: { code: string; creditCents: number } | null = null;
    if (voucherCode && voucherCode.trim()) {
      const voucherResult = await validateVoucher(
        voucherCode.trim(),
        context.accountId,
        amountCents
      );

      if (!voucherResult.valid) {
        return NextResponse.json(
          { error: voucherResult.error },
          { status: 400 }
        );
      }

      validatedVoucher = {
        code: voucherResult.voucher!.code,
        creditCents: voucherResult.voucher!.creditCents,
      };
    }

    // Build description with voucher bonus if applicable
    let description = `Add $${(amountCents / 100).toFixed(0)} to your wallet balance`;
    if (validatedVoucher) {
      description += ` + $${(validatedVoucher.creditCents / 100).toFixed(0)} bonus`;
    }

    // Generate a fresh token for the return URL so the user stays authenticated
    // after Stripe redirects back (the dashboard requires ?token= in the URL).
    // Use 2-hour expiry to allow time for checkout completion.
    const returnToken = generateCustomerToken(payload.email, payload.customerId, {
      expiresInHours: 2,
      userId: payload.userId,
      activeAccountId: context.accountId,
    });

    // Create checkout session for one-time payment
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer: context.accountId,
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: "GPU Wallet Top-Up",
              description,
            },
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        metadata: {
          type: "wallet_topup",
          customer_id: context.accountId,
          voucher_code: validatedVoucher?.code || "",
        },
      },
      metadata: {
        type: "wallet_topup",
        customer_id: context.accountId,
        voucher_code: validatedVoucher?.code || "",
      },
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?token=${returnToken}&topup=success&amount=${amountCents}${validatedVoucher ? `&bonus=${validatedVoucher.creditCents}` : ""}${launchProductId ? `&launchProduct=${encodeURIComponent(launchProductId)}` : ""}`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?token=${returnToken}&topup=canceled${launchProductId ? `&launchProduct=${encodeURIComponent(launchProductId)}` : ""}`,
    });

    return NextResponse.json({
      url: session.url,
      voucherApplied: validatedVoucher
        ? {
            code: validatedVoucher.code,
            creditCents: validatedVoucher.creditCents,
          }
        : null,
    });
  } catch (error) {
    console.error("Wallet top-up error:", error);
    return NextResponse.json(
      { error: "Failed to create checkout session" },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({ amounts: TOP_UP_AMOUNTS, custom: CUSTOM_TOP_UP });
}
