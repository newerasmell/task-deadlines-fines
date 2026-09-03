import { formatDateTime } from "../lib/dateFormat";
import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import { broadcastToAdmins } from "../notifications/adminBroadcast";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";

const WEEKDAY_CODES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

// Whether `dayStart` is a day this template should spawn an occurrence on.
// MONTHLY clamps to the month's last day when dayOfMonth falls past it
// (e.g. dayOfMonth 31 spawns on the 30th in April, the 28th/29th in
// February) rather than silently never firing that month.
function isDueOn(template: { frequency: string; daysOfWeek: string; dayOfMonth: number | null }, dayStart: Date): boolean {
  if (template.frequency === "MONTHLY") {
    if (!template.dayOfMonth) return false;
    const target = Math.min(template.dayOfMonth, daysInMonth(dayStart));
    return dayStart.getDate() === target;
  }
  const days = template.daysOfWeek.split(",").map((d) => d.trim().toUpperCase());
  return days.includes(WEEKDAY_CODES[dayStart.getDay()]);
}

/**
 * For every active RecurringTaskTemplate, looks ahead `RECURRING_LOOKAHEAD_DAYS`
 * days (today included) and creates a Task occurrence for each matching day
 * that doesn't already have one — so occurrences are visible to the assignee
 * (and eligible for the normal pre-deadline reminder) well before their own
 * deadline, instead of only appearing the day they're due. A template with no
 * end date just keeps producing new occurrences forever, one lookahead window
 * at a time. daysOfWeek/timeOfDay are interpreted in the server process's
 * local time zone.
 */
let lastThrottledSpawnAt = 0;
const SPAWN_THROTTLE_MS = 60_000;

/**
 * Same as spawnRecurringOccurrences, but safe to call from a request handler:
 * skips (rather than re-scanning every template) if it already ran within
 * the last minute, and never throws — a failed spawn attempt shouldn't break
 * the page that triggered it. This exists because the background cron only
 * runs while the process is alive; on a host that suspends an idle web
 * service (e.g. Render's free tier), a due occurrence could otherwise sit
 * unspawned for however long the process was asleep, with nothing visible
 * to the assignee (no task to submit against, no reminder) until the next
 * tick after it wakes back up. Calling this from GET /tasks means loading
 * the page itself is enough to catch it up.
 */
export async function spawnRecurringOccurrencesThrottled(now: Date = new Date()): Promise<void> {
  const nowMs = Date.now();
  if (nowMs - lastThrottledSpawnAt < SPAWN_THROTTLE_MS) return;
  lastThrottledSpawnAt = nowMs;
  try {
    await spawnRecurringOccurrences(now);
  } catch (err) {
    console.error("[recurringTasks] throttled spawn failed:", err);
  }
}

export async function spawnRecurringOccurrences(now: Date): Promise<void> {
  const templates = await prisma.recurringTaskTemplate.findMany({
    where: { active: true },
    include: { assignee: true, owner: true },
  });

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

  for (const template of templates) {
    const [hh, mm] = template.timeOfDay.split(":").map(Number);

    for (let offset = 0; offset <= env.recurringLookaheadDays; offset++) {
      const dayStart = new Date(today.getTime() + offset * 24 * 60 * 60 * 1000);
      if (!isDueOn(template, dayStart)) continue;

      const deadline = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), hh, mm, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

      const existing = await prisma.task.findFirst({
        where: { templateId: template.id, deadline: { gte: dayStart, lt: dayEnd } },
      });
      if (existing) continue;

      const task = await prisma.task.create({
        data: {
          title: template.title,
          description: template.description,
          assigneeId: template.assigneeId,
          ownerId: template.ownerId,
          createdById: template.createdById,
          templateId: template.id,
          deadline,
          priority: template.priority,
          status: "PENDING",
        },
      });

      await dispatchToAllChannels(
        toNotificationTarget(template.assignee),
        {
          subject: `Нова задача: ${task.title}`,
          body: `Повтаряща се задача — срок ${formatDateTime(deadline)}.\n\n${task.description ?? ""}`,
          deadline,
        },
        { taskId: task.id }
      );
      if (template.owner) {
        await dispatchToAllChannels(
          toNotificationTarget(template.owner),
          {
            subject: `Назначен си като преглеждащ: ${task.title}`,
            body: `Ти си Owner (преглеждащ) на повтаряща се задача "${task.title}" (изпълнител: ${template.assignee.name}, срок ${formatDateTime(deadline)}).`,
            deadline,
          },
          { taskId: task.id }
        );
      }
      await broadcastToAdmins({
        subject: "Нова повтаряща се задача",
        body: `"${task.title}" → ${template.assignee.name}, срок ${formatDateTime(deadline)}.`,
      });
    }
  }
}
