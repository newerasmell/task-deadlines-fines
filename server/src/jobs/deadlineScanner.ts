import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";
import { calculateFine, hoursBetween } from "../services/fineCalculator";

const OPEN_STATUSES = ["PENDING", "IN_PROGRESS", "OVERDUE"] as const;

async function pickRuleFor(priority: string) {
  const specific = await prisma.fineRule.findFirst({ where: { priority, active: true } });
  if (specific) return specific;
  return prisma.fineRule.findFirst({ where: { priority: null, active: true } });
}

/**
 * Sends "deadline approaching" reminders so employees can't claim they
 * forgot, then flags newly-overdue tasks and applies/escalates fines for
 * tasks that remain overdue, notifying on every channel available.
 */
export async function runDeadlineScan(now: Date = new Date()): Promise<void> {
  await sendUpcomingReminders(now);
  await handleOverdueTasks(now);
}

async function sendUpcomingReminders(now: Date): Promise<void> {
  const reminderThreshold = new Date(now.getTime() + env.reminderHoursBefore * 60 * 60 * 1000);

  const dueSoon = await prisma.task.findMany({
    where: {
      status: { in: ["PENDING", "IN_PROGRESS"] },
      reminderSentAt: null,
      deadline: { lte: reminderThreshold, gt: now },
    },
    include: { assignee: true },
  });

  for (const task of dueSoon) {
    const target = toNotificationTarget(task.assignee);
    await dispatchToAllChannels(
      target,
      {
        subject: `Наближава срок: ${task.title}`,
        body: `Срокът е ${task.deadline.toLocaleString("bg-BG")}. Завърши задачата навреме, за да избегнеш глоба.`,
        deadline: task.deadline,
      },
      { taskId: task.id }
    );
    await prisma.task.update({ where: { id: task.id }, data: { reminderSentAt: now } });
  }
}

async function handleOverdueTasks(now: Date): Promise<void> {
  const overdue = await prisma.task.findMany({
    where: {
      status: { in: OPEN_STATUSES as unknown as string[] },
      deadline: { lt: now },
    },
    include: { assignee: true },
  });

  for (const task of overdue) {
    const rule = await pickRuleFor(task.priority);
    if (!rule) continue; // No fine rule configured; still mark overdue below.

    const hoursLate = hoursBetween(task.deadline, now);
    const { daysLate, amount, currency } = calculateFine(hoursLate, rule);

    const wasAlreadyOverdue = task.status === "OVERDUE";
    const isNewEscalationDay = daysLate > (await currentDaysLate(task.id));

    if (!wasAlreadyOverdue) {
      await prisma.task.update({ where: { id: task.id }, data: { status: "OVERDUE" } });
    }

    if (amount > 0 && isNewEscalationDay) {
      const fine = await prisma.fine.create({
        data: {
          taskId: task.id,
          userId: task.assigneeId,
          amount,
          currency,
          daysLate,
          reason: `Неоснователно закъснение по задача "${task.title}" (${daysLate} ${daysLate === 1 ? "ден" : "дни"} закъснение)`,
        },
      });
      await prisma.task.update({ where: { id: task.id }, data: { lastEscalationAt: now } });

      const target = toNotificationTarget(task.assignee);
      await dispatchToAllChannels(
        target,
        {
          subject: `Просрочена задача и наложена глоба`,
          body: `Задачата "${task.title}" е просрочена с ${daysLate} ${daysLate === 1 ? "ден" : "дни"}.\nНаложена глоба: ${fine.amount} ${fine.currency}.\nАко закъснението е основателно, свържи се с администратор за анулиране.`,
        },
        { taskId: task.id }
      );
    }
  }
}

async function currentDaysLate(taskId: string): Promise<number> {
  const latest = await prisma.fine.findFirst({
    where: { taskId },
    orderBy: { createdAt: "desc" },
  });
  return latest?.daysLate ?? 0;
}
