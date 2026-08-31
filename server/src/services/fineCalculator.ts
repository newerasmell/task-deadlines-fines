export interface FineRuleInput {
  baseAmount: number;
  perDayAmount: number;
  graceHours: number;
  maxAmount: number | null;
  currency: string;
}

export interface FineCalculationResult {
  daysLate: number;
  amount: number;
  currency: string;
}

/**
 * Computes the fine for a task that is `hoursLate` hours past its deadline.
 * Within the grace period, no fine applies. After that, a base amount is
 * charged plus perDayAmount for each full day late (day 1 counts immediately
 * once the grace period elapses), capped at maxAmount if set.
 */
export function calculateFine(hoursLate: number, rule: FineRuleInput): FineCalculationResult {
  if (hoursLate <= rule.graceHours) {
    return { daysLate: 0, amount: 0, currency: rule.currency };
  }

  const effectiveHoursLate = hoursLate - rule.graceHours;
  const daysLate = Math.max(1, Math.ceil(effectiveHoursLate / 24));

  let amount = rule.baseAmount + rule.perDayAmount * (daysLate - 1);
  if (rule.maxAmount != null) {
    amount = Math.min(amount, rule.maxAmount);
  }
  amount = Math.round(amount * 100) / 100;

  return { daysLate, amount, currency: rule.currency };
}

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / (1000 * 60 * 60);
}
