import { describe, expect, it } from "vitest";
import { getTemplateDefault } from "@/lib/email/template-defaults";

describe("voucher email default", () => {
  it("names no GPU or hour estimate, since admins set which GPUs exist and what they cost", () => {
    const template = getTemplateDefault("game-voucher");
    expect(template).not.toBeNull();
    for (const body of [template!.html, template!.text]) {
      expect(body).toContain("{{creditDollars}} GPU Credits");
      expect(body).not.toMatch(/RTX PRO 6000|compute time|Approx\./);
    }
  });
});
