import { describe, expect, it } from "vitest";
import {
  canDo, deliveryText, eligibilityLabel, formatMoney, inviteLink, nextActionCopy,
  parseFragmentToken, requirementLabel, sourceLabel,
} from "@/lib/format";

describe("ui lib", () => {
  it("parses the token from the fragment", () => {
    expect(parseFragmentToken("#k=abc_-1")).toBe("abc_-1");
    expect(parseFragmentToken("#x=1&k=a%20b")).toBe("a b");
    expect(parseFragmentToken("")).toBeNull();
    expect(parseFragmentToken("#k=%E0%A4%A")).toBeNull();
  });
  it("builds invite links with the token in the fragment only", () => {
    expect(inviteLink("https://x.test", "t1", "tok")).toBe("https://x.test/t/t1#k=tok");
  });
  it("formats money and delivery honestly", () => {
    expect(formatMoney(1999, "USD")).toBe("USD 19.99");
    expect(formatMoney(null, "USD")).toBe("Not confirmed");
    expect(deliveryText(null, "USD")).toBe("Delivery not confirmed");
    expect(deliveryText(0, "USD")).toBe("Free delivery");
    expect(deliveryText(500, "USD")).toBe("Delivery USD 5.00");
  });
  it("labels", () => {
    expect(eligibilityLabel("unresolved")).toBe("Unverified");
    expect(eligibilityLabel("ineligible")).toBe("Doesn't match");
    expect(sourceLabel("external")).toBe("External retailer link");
    expect(sourceLabel("paypal")).toBe("Demo seller (sandbox)");
    expect(nextActionCopy("buy_at_retailer").headline).toMatch(/retailer/);
    expect(requirementLabel({ key: "opening", op: "eq", value: "top" })).toBe("opening: top");
  });
  it("role actions", () => {
    expect(canDo(["chooser"], "choose")).toBe(true);
    expect(canDo(["payer"], "choose")).toBe(false);
    expect(canDo(["helper"], "invite")).toBe(true);
  });
});
