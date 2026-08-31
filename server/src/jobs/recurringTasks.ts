import { prisma } from "../lib/prisma";
import { broadcastToAdmins } from "../notifications/adminBroadcast";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";

const WEEKDAY_CODES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

/**
 * For every active RecurringTaskTemplate whose daysOfWeek includes today,
 * creates today's Task occurrence (deadline = today at timeOfDay) unless one
 * already exists — so a template with no end date just keeps producing new
 * occurrences forever, without ever materializing more than a few rows at a
 * time. daysOfWeek/timeOfDay are interpreted in the server process's local
 * time zone.
 */
export async function spawnRecurringOccurrences(now: Date): Promise<void> {
  const templates = await prisma.recurringTaskTemplate.findMany({
    where: { active: true },
    include: { assignee: true },
  });

  const todayCode = WEEKDAY_CODES[now.getDay()];

  for (const template of templates) {
    const days = template.daysOfWeek.split(",").map((d) => d.trim().toUpperCase());
    if (!days.includes(todayCode)) continue;

    const [hh, mm] = template.timeOfDay.split(":").map(Number);
    const deadline = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
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
        body: `Повтаряща се задача — срок днес ${deadline.toLocaleString("bg-BG")}.\n\n${task.description ?? ""}`,
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
