import { DateTime } from "luxon";
import { isWithinDailyWindow, nextBusinessWindowStart } from "./businessHours";
import { describeNonWorkingDay } from "./bulgarianHolidays";
import { env } from "./env";
import { isOnLeave } from "./leave";

export interface DeadlineViolation {
  reason: string;
  nextAvailable: Date;
}

/**
 * Validates a task deadline against a User.businessHoursOnly assignee's
 * actual availability: a working day (not a weekend or BG holiday), not a
 * day they have an approved Leave for, and inside the team's daily business
 * window (env.reviewBusinessStartHour/EndHour). Returns null when the
 * deadline is fine as-is, otherwise which rule it broke plus the next
 * moment the assignee would actually be reachable for it.
 */
export async function checkDeadlineForBusinessHoursAssignee(
  assigneeId: string,
  deadline: Date
): Promise<DeadlineViolation | null> {
  const dayLabel = describeNonWorkingDay(deadline);
  if (dayLabel) {
    return { reason: dayLabel, nextAvailable: await nextAvailableDeadlineMoment(assigneeId, deadline) };
  }
  if (await isOnLeave(assigneeId, deadline)) {
    return {
      reason: "служителят е отбелязал този ден като почивен (одобрена отпуска)",
      nextAvailable: await nextAvailableDeadlineMoment(assigneeId, deadline),
    };
  }
  if (!isWithinDailyWindow(deadline)) {
    return {
      reason: `срокът е извън работното време (${env.reviewBusinessStartHour}:00–${env.reviewBusinessEndHour}:00)`,
      nextAvailable: await nextAvailableDeadlineMoment(assigneeId, deadline),
    };
  }
  return null;
}

// Walks forward a whole working day at a time from `from`'s next business
// window opening, skipping any day the assignee has Leave booked, until it
// lands on one they're actually free for — weekends/BG holidays are already
// skipped by nextBusinessWindowStart itself.
async function nextAvailableDeadlineMoment(assigneeId: string, from: Date): Promise<Date> {
  let candidate = nextBusinessWindowStart(from);
  while (await isOnLeave(assigneeId, candidate)) {
    const nextDay = DateTime.fromJSDate(candidate, { zone: env.timezone }).plus({ days: 1 }).startOf("day").toJSDate();
    candidate = nextBusinessWindowStart(nextDay);
  }
  return candidate;
}
