import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

vi.mock("@/lib/customer-cache", () => ({ cacheCustomer: vi.fn().mockResolvedValue(undefined) }));
import { createInvoiceForPayment } from "@/lib/invoice";

// A Stripe stand-in whose balance moves only on real (non-replayed) adjustments.
function fakeStripe(startBalance: number) {
  const state = { balance: startBalance, applied: new Set<string>() };
  let unkeyed = 0;
  const createBalanceTransaction = vi.fn(async (_id: string, params: { amount: number }, opts?: { idempotencyKey?: string }) => {
    const key = opts?.idempotencyKey ?? `unkeyed-${unkeyed++}`;
    if (!state.applied.has(key)) {
      state.applied.add(key);
      state.balance += params.amount;
    }
    return {};
  });
  const stripe = {
    invoices: {
      create: vi.fn().mockResolvedValue({ id: "in_1" }),
      finalizeInvoice: vi.fn().mockResolvedValue({}),
      pay: vi.fn().mockResolvedValue({}),
    },
    invoiceItems: { create: vi.fn().mockResolvedValue({}) },
    customers: {
      retrieve: vi.fn(async () => ({ id: "cus_1", balance: state.balance })),
      createBalanceTransaction,
    },
  };
  return { stripe: stripe as unknown as Stripe, state, createBalanceTransaction, raw: stripe };
}

describe("createInvoiceForPayment balance hold", () => {
  beforeEach(() => vi.clearAllMocks());

  it("holds and restores the wallet around finalization", async () => {
    const { stripe, state, raw } = fakeStripe(-37500);
    raw.invoices.finalizeInvoice.mockImplementation(async () => {
      expect(state.balance).toBe(0);
      return {};
    });

    await createInvoiceForPayment(stripe, "cus_1", 37500, "Wallet Top-up");

    expect(state.balance).toBe(-37500);
  });

  it("restores the wallet when the hold landed but its response was lost", async () => {
    const { stripe, state, createBalanceTransaction } = fakeStripe(-37500);
    const real = createBalanceTransaction.getMockImplementation()!;
    createBalanceTransaction.mockImplementationOnce(async (...args: Parameters<typeof real>) => {
      await real(...args);
      throw new Error("socket hang up");
    });

    await createInvoiceForPayment(stripe, "cus_1", 37500, "Wallet Top-up");

    expect(state.balance).toBe(-37500);
    expect(createBalanceTransaction.mock.calls.map(c => c[2]?.idempotencyKey)).toEqual(["invoice-hold-in_1", "invoice-hold-in_1", "invoice-restore-in_1"]);
  });

  it("retries a failed restore so the wallet is not left zeroed", async () => {
    const { stripe, state, createBalanceTransaction } = fakeStripe(-37500);
    const real = createBalanceTransaction.getMockImplementation()!;
    createBalanceTransaction
      .mockImplementationOnce(real)
      .mockImplementationOnce(async () => { throw new Error("stripe_api_error"); });

    await createInvoiceForPayment(stripe, "cus_1", 37500, "Wallet Top-up");

    expect(state.balance).toBe(-37500);
  });

  it("restores the wallet even when finalization fails", async () => {
    const { stripe, state, raw } = fakeStripe(-37500);
    raw.invoices.finalizeInvoice.mockRejectedValue(new Error("finalize failed"));

    await createInvoiceForPayment(stripe, "cus_1", 37500, "Wallet Top-up");

    expect(state.balance).toBe(-37500);
  });
});
