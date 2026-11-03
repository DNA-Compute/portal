import { describe, it, expect } from "vitest";
import { generateCustomerToken, decodeCustomerToken } from "@/lib/auth/customer";

// PA-266: the deep-link "next" target rides inside the signed magic-link token
// so it survives the login round-trip and cannot be rewritten by a recipient.
describe("generateCustomerToken — next claim", () => {
  it("round-trips a safe same-origin relative path into the verified payload", () => {
    const token = generateCustomerToken("user@example.com", "cus_1", {
      next: "/dashboard?gpu=b200&plan=monthly",
    });
    expect(decodeCustomerToken(token)?.next).toBe("/dashboard?gpu=b200&plan=monthly");
  });

  it("strips an unsafe next at sign time — it never reaches the token", () => {
    for (const bad of ["//evil.com", "https://evil.com", "/admin", "/dashboard/../admin"]) {
      const token = generateCustomerToken("user@example.com", "cus_1", { next: bad });
      expect(decodeCustomerToken(token)?.next).toBeUndefined();
    }
  });

  it("omits next entirely when none is provided", () => {
    const token = generateCustomerToken("user@example.com", "cus_1");
    expect(decodeCustomerToken(token)?.next).toBeUndefined();
  });
});
