import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BillingDoc } from "@/app/dashboard/components/docs/BillingDoc";

afterEach(cleanup);

describe("billing guide", () => {
  it("names no fixed GPU or storage price, since admins set them per product", () => {
    const { container } = render(<BillingDoc />);
    const text = container.textContent ?? "";
    // The worked example may use an illustrative rate, but only once and labelled as one.
    expect(text.match(/\$\d+(\.\d+)?\/(hr|mo|GB)/g)).toEqual(["$3.00/hr"]);
    expect(text).toContain("an example rate");
    expect(text).not.toMatch(/RTX PRO 6000|\$299|~\d+ hours/);
  });
});
