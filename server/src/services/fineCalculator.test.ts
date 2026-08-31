import { describe, expect, it } from "vitest";
import { calculateFine } from "./fineCalculator";

const rule = { baseAmount: 20, perDayAmount: 10, graceHours: 2, maxAmount: 100, currency: "BGN" };

describe("calculateFine", () => {
  it("charges nothing within the grace period", () => {
    expect(calculateFine(1, rule)).toEqual({ daysLate: 0, amount: 0, currency: "BGN" });
    expect(calculateFine(2, rule)).toEqual({ daysLate: 0, amount: 0, currency: "BGN" });
  });

  it("charges the base amount just after the grace period", () => {
    const result = calculateFine(3, rule);
    expect(result.daysLate).toBe(1);
    expect(result.amount).toBe(20);
  });

  it("adds per-day amount for each additional full day late", () => {
    // 2h grace + 25h effective => ceil(25/24) = 2 days late
    const result = calculateFine(27, rule);
    expect(result.daysLate).toBe(2);
    expect(result.amount).toBe(30);
  });

  it("caps the fine at maxAmount", () => {
    const result = calculateFine(24 * 30, rule);
    expect(result.amount).toBeLessThanOrEqual(100);
    expect(result.amount).toBe(100);
  });
});
