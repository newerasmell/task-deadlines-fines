import { isNonWorkingDay } from "./bulgarianHolidays";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fallback deadline when Claude's extraction doesn't return a usable date
 * (missing, unparseable, or in the past) — `workingDays` calendar days
 * forward from `from`, skipping weekends/BG holidays, same non-working-day
 * rule the fine engine already uses elsewhere.
 */
export function addWorkingDays(from: Date, workingDays: number): Date {
  let result = new Date(from.getTime());
  let remaining = workingDays;
  while (remaining > 0) {
    result = new Date(result.getTime() + DAY_MS);
    if (!isNonWorkingDay(result)) remaining--;
  }
  return result;
}
