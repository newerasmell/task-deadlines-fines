import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import { broadcastToAdmins } from "../notifications/adminBroadcast";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";
import { calculateFine, hoursBetween } from "../services/fineCalculator";
import { spawnRecurringOccurrences } from "./recurringTasks";

const OPEN_STATUSES = ["PENDING", "IN_PROGRESS", "OVERDUE"] as const;

async function pickRuleFor(priority: string) {
  const specific = await prisma.fineRule.findFirst({ where: { priority, active: true } });
  if (specific) return specific;
  return prisma.fineRule.findFirst({ where: { priority: null, active: true } });
}

/**
 * Spawns due occurrences of recurring task templates, sends "deadline
 * approaching" reminders so employees can't claim they forgot, flags
 * newly-overdue tasks and applies/escalates fines for tasks that remain
 * overdue, and separately fines Owners who let a submitted task's review sit
 * past its own review deadline — notifying on every channel available.
 */
export async function runDeadlineScan(now: Date = new Date()): Promise<void> {
  await spawnRecurringOccurrences(now);
  await sendUpcomingReminders(now);
  await handleOverdueTasks(now);
  await handleOverdueReviews(now);
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
    const isNewEscalationDay = daysLate > (await currentDaysLate(task.id, task.assigneeId));

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
      await broadcastToAdmins({
        subject: "Просрочие и глоба",
        body: `"${task.title}" (${task.assignee.name}) — ${daysLate} ${daysLate === 1 ? "ден" : "дни"} закъснение, глоба ${fine.amount} ${fine.currency}.`,
      });
    }
  }
}

/**
 * A submitted task's review is itself subject to a deadline (REVIEW_DUE_HOURS
 * after submission). If the Owner sits on it past that point, they accrue a
 * fine through the exact same engine used for task deadlines — the Owner's
 * job of checking the work is a deadline too.
 */
async function handleOverdueReviews(now: Date): Promise<void> {
  const pendingReviews = await prisma.taskSubmission.findMany({
    where: { reviewStatus: "PENDING", reviewDueAt: { lt: now } },
    include: { task: { include: { owner: true } } },
  });

  for (const submission of pendingReviews) {
    const task = submission.task;
    if (!task.ownerId || !task.owner) continue; // No owner assigned; nothing to fine.

    const rule = await pickRuleFor(task.priority);
    if (!rule) continue;

    const hoursLate = hoursBetween(submission.reviewDueAt!, now);
    const { daysLate, amount, currency } = calculateFine(hoursLate, rule);
    if (amount <= 0) continue;

    const priorDaysLate = await currentDaysLate(task.id, task.ownerId);
    if (daysLate <= priorDaysLate) continue;

    const fine = await prisma.fine.create({
      data: {
        taskId: task.id,
        userId: task.ownerId,
        amount,
        currency,
        daysLate,
        reason: `Забавен преглед на подадена задача "${task.title}" (${daysLate} ${daysLate === 1 ? "ден" : "дни"} закъснение на прегледа)`,
      },
    });
    await prisma.taskSubmission.update({ where: { id: submission.id }, data: { reviewLastEscalationAt: now } });

    await dispatchToAllChannels(toNotificationTarget(task.owner), {
      subject: "Забавен преглед и наложена глоба",
      body: `Все още не си прегледал подадената задача "${task.title}". Просрочие на прегледа: ${daysLate} ${daysLate === 1 ? "ден" : "дни"}. Наложена глоба: ${fine.amount} ${fine.currency}.`,
    });
    await broadcastToAdmins({
      subject: "Забавен преглед и глоба",
      body: `Owner ${task.owner.name} не прегледа "${task.title}" навреме — ${daysLate} ${daysLate === 1 ? "ден" : "дни"} закъснение, глоба ${fine.amount} ${fine.currency}.`,
    });
  }
}

async function currentDaysLate(taskId: string, userId: string): Promise<number> {
  const latest = await prisma.fine.findFirst({
    where: { taskId, userId },
    orderBy: { createdAt: "desc" },
  });
  return latest?.daysLate ?? 0;
}
