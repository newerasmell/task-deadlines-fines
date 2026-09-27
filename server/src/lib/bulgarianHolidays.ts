// Saturdays, Sundays, and Bulgaria's official non-working holidays (Labour
// Code Art. 154) all pause the fine clock for both task deadlines and review
// deadlines — mirroring how an approved Leave already pauses it, but for
// everyone rather than one person. Dates are computed algorithmically so
// this needs no yearly maintenance; it does NOT include the occasional
// government-decreed "moved" day off when a fixed holiday lands on a
// weekend (those are announced case-by-case, not on a fixed rule).

import { DateTime } from "luxon";
import { env } from "./env";

const DAY_MS = 24 * 60 * 60 * 1000;

// Orthodox Easter (Gregorian calendar date) via the Meeus Julian algorithm,
// +13 days to convert Julian -> Gregorian. Valid for years 1900-2099. Pure
// calendar-date arithmetic — UTC here is just a scratch epoch for the day
// math, not a real instant, so it needs no timezone handling of its own.
function orthodoxEaster(year: number): Date {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31); // 3 = March, 4 = April (Julian)
  const day = ((d + e + 114) % 31) + 1;
  const julian = Date.UTC(year, month - 1, day);
  return new Date(julian + 13 * DAY_MS);
}

function dateKey(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Holidays are calendar dates, not instants, so they're kept and compared
// as plain "YYYY-MM-DD" keys throughout — sidesteps timezone entirely
// instead of round-tripping through a Date that would need one.
function bulgarianHolidayEntries(year: number): Array<{ key: string; name: string }> {
  const easter = orthodoxEaster(year).getTime();
  const easterOffset = (days: number) => {
    const d = new Date(easter + days * DAY_MS);
    return dateKey(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  return [
    { key: dateKey(year, 0, 1), name: "Нова година" },
    { key: dateKey(year, 2, 3), name: "Ден на Освобождението" },
    { key: easterOffset(-2), name: "Велики петък" },
    { key: easterOffset(-1), name: "Велика събота" },
    { key: easterOffset(0), name: "Великден" },
    { key: easterOffset(1), name: "Велики понеделник" },
    { key: dateKey(year, 4, 1), name: "Ден на труда" },
    { key: dateKey(year, 4, 6), name: "Гергьовден" },
    { key: dateKey(year, 4, 24), name: "Ден на българската просвета и култура" },
    { key: dateKey(year, 8, 6), name: "Ден на Съединението" },
    { key: dateKey(year, 8, 22), name: "Ден на независимостта" },
    { key: dateKey(year, 11, 24), name: "Бъдни вечер" },
    { key: dateKey(year, 11, 25), name: "Рождество Христово" },
    { key: dateKey(year, 11, 26), name: "Рождество Христово (втори ден)" },
  ];
}

function bulgarianHolidayKeys(year: number): string[] {
  return bulgarianHolidayEntries(year).map((e) => e.key);
}

// The named holiday `date` falls on (team-local calendar day), if any — null
// for a plain working day AND for a plain weekend with no named holiday.
// See describeNonWorkingDay below for the combined "why isn't this a
// working day" label a deadline-validation error message actually wants.
function bulgarianHolidayName(date: Date): string | null {
  const local = DateTime.fromJSDate(date, { zone: env.timezone });
  const key = local.toFormat("yyyy-MM-dd");
  for (const y of [local.year - 1, local.year, local.year + 1]) {
    const entry = bulgarianHolidayEntries(y).find((e) => e.key === key);
    if (entry) return entry.name;
  }
  return null;
}

// Human label for why `date` isn't a working day (team-local calendar day)
// — the specific holiday's name, a generic weekend label, or null if it's
// an ordinary working day. Used to explain a rejected deadline to whoever
// picked it, e.g. "Гергьовден (официален празник)".
export function describeNonWorkingDay(date: Date): string | null {
  const holiday = bulgarianHolidayName(date);
  if (holiday) return `${holiday} (официален празник)`;
  const local = DateTime.fromJSDate(date, { zone: env.timezone });
  if (local.weekday === 6 || local.weekday === 7) return "почивен ден (събота/неделя)";
  return null;
}

// Everything below resolves "which calendar day" via the team's own zone
// (env.timezone, Europe/Sofia), not the instant's UTC day — a fine clock
// pausing for a holiday needs to agree with when that holiday actually
// starts and ends for the team, not some UTC offset. Confirmed live as a
// real gap: a task with a deadline that didn't happen to land on a UTC day
// boundary could get up to ~2-3 hours (Bulgaria's UTC+2/+3 offset,
// depending on DST) of its actual local holiday wrongly counted as
// working time, or vice versa, right around local midnight.
export function isNonWorkingDay(date: Date): boolean {
  const local = DateTime.fromJSDate(date, { zone: env.timezone });
  if (local.weekday === 6 || local.weekday === 7) return true; // Luxon: 6=Sat, 7=Sun

  const key = local.toFormat("yyyy-MM-dd");
  const year = local.year;
  // Also check the neighboring years so Dec 31 / Jan 1 boundaries around
  // Christmas/New Year never miss a holiday computed for the "other" year.
  return [year - 1, year, year + 1].flatMap(bulgarianHolidayKeys).includes(key);
}

// Whether `deadline` itself was set for a Saturday or Sunday, going by the
// team's own local calendar day (env.timezone) rather than the UTC day the
// instant happens to fall on — a deadline is a real instant, and users think
// of "what day is this due" in their own timezone, not UTC. A task assigned
// a weekend deadline is deliberately meant to run through the weekend, so
// it's excluded from the pause entirely: its clock runs and fines apply
// exactly as if weekends/holidays didn't exist. Tasks with a Monday-Friday
// deadline are unaffected by this and keep the normal pause.
export function deadlineFallsOnWeekend(deadline: Date): boolean {
  const weekday = DateTime.fromJSDate(deadline, { zone: env.timezone }).weekday;
  return weekday === 6 || weekday === 7;
}

/** Hours of [from, to) that fall on a Saturday, Sunday, or BG holiday (team-local calendar days). */
export function nonWorkingHoursBetween(from: Date, to: Date): number {
  if (to <= from) return 0;

  const toMs = to.getTime();
  let overlapMs = 0;
  let cursor = DateTime.fromJSDate(from, { zone: env.timezone }).startOf("day");
  while (cursor.toMillis() < toMs) {
    const dayStart = cursor;
    const dayEnd = cursor.plus({ days: 1 });
    if (isNonWorkingDay(dayStart.toJSDate())) {
      const start = Math.max(dayStart.toMillis(), from.getTime());
      const end = Math.min(dayEnd.toMillis(), toMs);
      if (end > start) overlapMs += end - start;
    }
    cursor = dayEnd;
  }
  return overlapMs / (1000 * 60 * 60);
}
