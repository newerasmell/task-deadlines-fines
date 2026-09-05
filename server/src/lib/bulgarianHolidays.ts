// Saturdays, Sundays, and Bulgaria's official non-working holidays (Labour
// Code Art. 154) all pause the fine clock for both task deadlines and review
// deadlines — mirroring how an approved Leave already pauses it, but for
// everyone rather than one person. Dates are computed algorithmically so
// this needs no yearly maintenance; it does NOT include the occasional
// government-decreed "moved" day off when a fixed holiday lands on a
// weekend (those are announced case-by-case, not on a fixed rule).

const DAY_MS = 24 * 60 * 60 * 1000;

// Orthodox Easter (Gregorian calendar date) via the Meeus Julian algorithm,
// +13 days to convert Julian -> Gregorian. Valid for years 1900-2099.
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

function bulgarianHolidays(year: number): Date[] {
  const easter = orthodoxEaster(year).getTime();
  return [
    new Date(Date.UTC(year, 0, 1)), // Нова година
    new Date(Date.UTC(year, 2, 3)), // Ден на Освобождението
    new Date(easter - 2 * DAY_MS), // Велики петък
    new Date(easter - 1 * DAY_MS), // Велика събота
    new Date(easter), // Великден
    new Date(easter + 1 * DAY_MS), // Велики понеделник
    new Date(Date.UTC(year, 4, 1)), // Ден на труда
    new Date(Date.UTC(year, 4, 6)), // Гергьовден
    new Date(Date.UTC(year, 4, 24)), // Ден на българската просвета и култура
    new Date(Date.UTC(year, 8, 6)), // Ден на Съединението
    new Date(Date.UTC(year, 8, 22)), // Ден на независимостта
    new Date(Date.UTC(year, 11, 24)), // Бъдни вечер
    new Date(Date.UTC(year, 11, 25)), // Рождество Христово
    new Date(Date.UTC(year, 11, 26)), // Рождество Христово (втори ден)
  ];
}

function dayKey(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function isNonWorkingDay(date: Date): boolean {
  const dow = date.getUTCDay();
  if (dow === 0 || dow === 6) return true;

  const year = date.getUTCFullYear();
  const key = dayKey(date);
  // Also check the neighboring years so Dec 31 / Jan 1 boundaries around
  // Christmas/New Year never miss a holiday computed for the "other" year.
  return [year - 1, year, year + 1]
    .flatMap(bulgarianHolidays)
    .some((h) => dayKey(h) === key);
}

/** Hours of [from, to) that fall on a Saturday, Sunday, or BG holiday. */
export function nonWorkingHoursBetween(from: Date, to: Date): number {
  if (to <= from) return 0;

  let overlapMs = 0;
  let cursor = new Date(dayKey(from));
  while (cursor.getTime() < to.getTime()) {
    const dayStart = cursor.getTime();
    const dayEnd = dayStart + DAY_MS;
    if (isNonWorkingDay(cursor)) {
      const start = Math.max(dayStart, from.getTime());
      const end = Math.min(dayEnd, to.getTime());
      if (end > start) overlapMs += end - start;
    }
    cursor = new Date(dayEnd);
  }
  return overlapMs / (1000 * 60 * 60);
}
