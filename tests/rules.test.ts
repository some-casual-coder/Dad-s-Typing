import { describe, expect, it } from "vitest";
import { evaluate } from "@/domain/eligibility";
import { fromDecimalString, toDecimalString } from "@/domain/money";

describe("eligibility", () => {
  const top = [{ key: "opening", op: "eq" as const, value: "top", essential: true }];
  it("matches, mismatches, and keeps unknown unresolved", () => {
    expect(evaluate(top, { opening: { value: "top" } }).status).toBe("eligible");
    expect(evaluate(top, { opening: { value: "front" } }).status).toBe("ineligible");
    expect(evaluate(top, {}).status).toBe("unresolved");
  });
  it("preferences never gate", () => {
    expect(evaluate([{ key: "color", op: "eq", value: "blue", essential: false }], { color: { value: "red" } }).status).toBe("eligible");
  });
  it("negation works", () => {
    expect(evaluate([{ key: "opening", op: "neq", value: "front", essential: true }], { opening: { value: "front" } }).status).toBe("ineligible");
  });
  it("compares lengths across units, unknown when units are unusable", () => {
    const r = [{ key: "length", op: "gte" as const, value: 45, unit: "cm", essential: true }];
    expect(evaluate(r, { length: { value: 18, unit: "in" } }).status).toBe("eligible"); // 45.72cm
    expect(evaluate(r, { length: { value: 17, unit: "in" } }).status).toBe("ineligible");
    expect(evaluate(r, { length: { value: 18, unit: "bananas" } }).status).toBe("unresolved");
  });
});

describe("money", () => {
  it("round-trips exact minor units", () => {
    expect(toDecimalString(3599, "USD")).toBe("35.99");
    expect(toDecimalString(5, "USD")).toBe("0.05");
    expect(fromDecimalString("35.99", "USD")).toBe(3599);
    expect(fromDecimalString("35", "USD")).toBe(3500);
    expect(() => fromDecimalString("35.999", "USD")).toThrow();
  });
});
