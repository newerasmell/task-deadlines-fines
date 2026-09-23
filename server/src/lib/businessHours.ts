import { DateTime } from "luxon";
import { isNonWorkingDay } from "./bulgarianHolidays";
import { env } from "./env";

// Review deadlines run on the team's actual working hours (default 9:00-18:00,
// Mon-Fri, minus BG holidays) rather than the wall clock — a submission made
// at 2am or on a Saturday shouldn't start burning down a reviewer's window
// before they've even had a chance to see it. Task deadlines themselves are
// unaffected. Also used by deadlineScanner to hold the periodic/final
// review-reminder nudges to the same window, so an Owner isn't pinged in
// the middle of the night or over the weekend.

function toZoned(date: Date): DateTime {
  return DateTime.fromJSDate(date, { zone: env.timezone });
}

function isWorkingDay(dt: DateTime): boolean {
  return !isNonWorkingDay(dt.toJSDate());
}

function windowStart(dt: DateTime): DateTime {
  return dt.set({ hour: env.reviewBusinessStartHour, minute: 0, second: 0, millisecond: 0 });
}

function windowEnd(dt: DateTime): DateTime {
  return dt.set({ hour: env.reviewBusinessEndHour, minute: 0, second: 0, millisecond: 0 });
}

// The next instant at or after `dt` that begins a business window — either
// later today (if today is a working day and its window hasn't opened yet)
// or 9:00 on the next working day otherwise.
function nextWindowStartAtOrAfter(dt: DateTime): DateTime {
  if (isWorkingDay(dt) && dt < windowStart(dt)) {
    return windowStart(dt);
  }
  let day = dt.plus({ days: 1 }).startOf("day");
  while (!isWorkingDay(day)) {
    day = day.plus({ days: 1 });
  }
  return windowStart(day);
}

/** Whether `date` falls inside a working day's business window (local time). */
export function isWithinBusinessHours(date: Date): boolean {
  const dt = toZoned(date);
  return isWorkingDay(dt) && dt >= windowStart(dt) && dt < windowEnd(dt);
}

/**
 * Adds `hours` of business time to `from`. If `from` itself is outside the
 * business window (evening, night, weekend, holiday), the clock starts at
 * the next window's opening instead of ticking through the gap; otherwise
 * it starts immediately and pauses at each day's close, resuming at the
 * next working day's open, until `hours` have actually elapsed.
 */
export function addBusinessHours(from: Date, hours: number): Date {
  let cursor = toZoned(from);
  if (!isWorkingDay(cursor) || cursor < windowStart(cursor) || cursor >= windowEnd(cursor)) {
    cursor = nextWindowStartAtOrAfter(cursor);
  }

  let remainingMs = hours * 60 * 60 * 1000;
  while (remainingMs > 0) {
    const dayEnd = windowEnd(cursor);
    const availableMs = dayEnd.toMillis() - cursor.toMillis();
    if (remainingMs <= availableMs) {
      cursor = cursor.plus({ milliseconds: remainingMs });
      remainingMs = 0;
    } else {
      remainingMs -= availableMs;
      cursor = nextWindowStartAtOrAfter(dayEnd);
    }
  }
  return cursor.toJSDate();
}

/**
 * Business hours actually contained in [from, to) — the inverse of
 * addBusinessHours, used to measure genuine lateness on a review deadline
 * (which was itself placed on a business boundary, so only business time
 * after it should ever count as "late").
 */
export function businessHoursBetween(from: Date, to: Date): number {
  if (to <= from) return 0;

  let totalMs = 0;
  let cursor = toZoned(from);
  const end = toZoned(to);
  while (cursor < end) {
    if (isWorkingDay(cursor)) {
      const dayStart = windowStart(cursor);
      const dayEnd = windowEnd(cursor);
      const start = cursor > dayStart ? cursor : dayStart;
      const finish = end < dayEnd ? end : dayEnd;
      if (finish > start) totalMs += finish.toMillis() - start.toMillis();
    }
    cursor = cursor.plus({ days: 1 }).startOf("day");
  }
  return totalMs / (1000 * 60 * 60);
}
