import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import { broadcastToAdmins } from "../notifications/adminBroadcast";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";

const WEEKDAY_CODES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

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
export async function spawnRecurringOccurrences(now: Date): Promise<void> {
  const templates = await prisma.recurringTaskTemplate.findMany({
    where: { active: true },
    include: { assignee: true },
  });

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);

  for (const template of templates) {
    const days = template.daysOfWeek.split(",").map((d) => d.trim().toUpperCase());
    const [hh, mm] = template.timeOfDay.split(":").map(Number);

    for (let offset = 0; offset <= env.recurringLookaheadDays; offset++) {
      const dayStart = new Date(today.getTime() + offset * 24 * 60 * 60 * 1000);
      if (!days.includes(WEEKDAY_CODES[dayStart.getDay()])) continue;

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
          body: `Повтаряща се задача — срок ${deadline.toLocaleString("bg-BG")}.\n\n${task.description ?? ""}`,
          deadline,
        },
        { taskId: task.id }
      );
      await broadcastToAdmins({
        subject: "Нова повтаряща се задача",
        body: `"${task.title}" → ${template.assignee.name}, срок ${deadline.toLocaleString("bg-BG")}.`,
      });
    }
  }
}
