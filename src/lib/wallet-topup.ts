/** Wallet top-up amounts, shared by the checkout API and the top-up modal. All values in cents. */
export const TOP_UP_AMOUNTS = [
  { value: 2500, label: "$25" },
  { value: 5000, label: "$50" },
  { value: 10000, label: "$100" },
  { value: 25000, label: "$250" },
  { value: 50000, label: "$500" },
];

/** A custom top-up is a whole-dollar amount inside these bounds. */
export const CUSTOM_TOP_UP = { minCents: 2500, maxCents: 1_000_000 };

export function isValidTopUpAmount(cents: unknown): cents is number {
  if (typeof cents !== "number" || !Number.isInteger(cents)) return false;
  if (TOP_UP_AMOUNTS.some(amount => amount.value === cents)) return true;
  return cents % 100 === 0 && cents >= CUSTOM_TOP_UP.minCents && cents <= CUSTOM_TOP_UP.maxCents;
}
