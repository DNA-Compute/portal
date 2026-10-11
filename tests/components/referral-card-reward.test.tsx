import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import ReferralCard from "@/components/ReferralCard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("referral card reward", () => {
  it("states the reward and qualifying top-up the platform is configured with, in dollars", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      enabled: true, code: "abc123",
      stats: { code: "abc123", totalReferrals: 2, pendingReferrals: 0, creditedReferrals: 1, totalEarned: 2500 },
      referrals: [], rewardAmount: 25, minTopupRequired: 50, maxReferrals: 0,
      usedReferralCode: null, usedReferralStatus: null,
    })));
    await act(async () => { render(<ReferralCard token="t" />); });

    // GPU prices vary by product and configuration, so the reward is credit, not GPU hours.
    expect(screen.queryAllByText(/hours free|GPU time|~\d+h\b/)).toHaveLength(0);
    expect(screen.getByText("Share your code and you both get $25 credit.")).toBeInTheDocument();
    expect(screen.getByText(/tops up \$50 or more/)).toBeInTheDocument();
  });
});
