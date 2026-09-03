import { formatDateTime } from "../lib/dateFormat";
import { env } from "../lib/env";
import { prisma } from "../lib/prisma";
import { broadcastToAdmins } from "../notifications/adminBroadcast";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";
import { calculateFine, hoursBetween } from "../services/fineCalculator";
import { spawnRecurringOccurrences } from "./recurringTasks";

export const OPEN_STATUSES = ["PENDING", "IN_PROGRESS", "OVERDUE"] as const;

// How many hours of the [from, to) window fall inside an approved Leave for
// this person — subtracted from their lateness before a fine is computed,
// so nobody accrues a fine (or an escalating one) for time they were
// pre-approved to be away. Applied to both the assignee's task deadline and
// the owner's review deadline below.
async function leaveHoursOverlap(userId: string, from: Date, to: Date): Promise<number> {
  if (to <= from) return 0;
  const leaves = await prisma.leave.findMany({
    where: { userId, startDate: { lt: to }, endDate: { gt: from } },
  });
  let overlapMs = 0;
  for (const leave of leaves) {
    const start = Math.max(leave.startDate.getTime(), from.getTime());
    const end = Math.min(leave.endDate.getTime(), to.getTime());
    if (end > start) overlapMs += end - start;
  }
  return overlapMs / (1000 * 60 * 60);
}

// Fine rules are assigned per account by the Ultimate Admin, not by task
// priority: a user pinned to a specific rule always uses it regardless of
// what they're overdue on; everyone else falls back to the one rule (if
// any) nobody is specifically assigned to.
async function pickRuleForUser(userId: string) {
  const specific = await prisma.fineRule.findFirst({
    where: { active: true, assignedUsers: { some: { userId } } },
  });
  if (specific) return specific;
  return prisma.fineRule.findFirst({ where: { active: true, assignedUsers: { none: {} } } });
}

/**
 * Spawns due occurrences of recurring task templates, sends "deadline
 * approaching" reminders so employees can't claim they forgot, flags
 * newly-overdue tasks and applies/escalates fines for tasks that remain
 * overdue, nudges Owners about submissions still waiting on their review,
 * and separately fines Owners who let a submitted task's review sit past its
 * own review deadline — notifying on every channel available.
 */
export async function runDeadlineScan(now: Date = new Date()): Promise<void> {
  await spawnRecurringOccurrences(now);
  await sendUpcomingReminders(now);
  await handleOverdueTasks(now);
  await sendUpcomingReviewReminders(now);
  await handleOverdueReviews(now);
}

/**
 * Three independent reminder tiers for an open task's assignee:
 *  - a repeating "still open" nudge every REMINDER_PERIODIC_HOURS (default
 *    48h), only for tasks whose total deadline-createdAt span is longer than
 *    that period, and only while more than REMINDER_HOURS_BEFORE remains;
 *  - a one-off reminder once REMINDER_HOURS_BEFORE (default 24h) remain;
 *  - a one-off final reminder once REMINDER_FINAL_HOURS_BEFORE (default 4h)
 *    remain.
 * The 24h and 4h reminders each fire exactly once per task (tracked via
 * their own *SentAt column); the periodic one keeps firing on its cadence
 * until the task enters the 24h window, where the one-off reminder takes over.
 */
async function sendUpcomingReminders(now: Date): Promise<void> {
  const standardMs = env.reminderHoursBefore * 60 * 60 * 1000;
  const finalMs = env.reminderFinalHoursBefore * 60 * 60 * 1000;
  const periodicMs = env.reminderPeriodicHours * 60 * 60 * 1000;

  const openTasks = await prisma.task.findMany({
    where: {
      deletedAt: null,
      status: { in: ["PENDING", "IN_PROGRESS"] },
      deadline: { gt: now },
    },
    include: { assignee: true },
  });

  for (const task of openTasks) {
    const timeToDeadlineMs = task.deadline.getTime() - now.getTime();
    const totalDurationMs = task.deadline.getTime() - task.createdAt.getTime();
    const target = toNotificationTarget(task.assignee);

    if (!task.reminder4hSentAt && timeToDeadlineMs <= finalMs) {
      await dispatchToAllChannels(
        target,
        {
          subject: `Последно напомняне: ${task.title}`,
          body: `Остават под ${env.reminderFinalHoursBefore} часа до срока (${formatDateTime(task.deadline)}). Завърши задачата навреме, за да избегнеш глоба.`,
          deadline: task.deadline,
        },
        { taskId: task.id }
      );
      await prisma.task.update({ where: { id: task.id }, data: { reminder4hSentAt: now } });
      continue;
    }

    if (!task.reminder24hSentAt && timeToDeadlineMs <= standardMs) {
      await dispatchToAllChannels(
        target,
        {
          subject: `Наближава срок: ${task.title}`,
          body: `Срокът е ${formatDateTime(task.deadline)}. Завърши задачата навреме, за да избегнеш глоба.`,
          deadline: task.deadline,
        },
        { taskId: task.id }
      );
      await prisma.task.update({ where: { id: task.id }, data: { reminder24hSentAt: now } });
      continue;
    }

    if (totalDurationMs > periodicMs && timeToDeadlineMs > standardMs) {
      const lastPeriodic = (task.lastPeriodicReminderAt ?? task.createdAt).getTime();
      if (now.getTime() - lastPeriodic >= periodicMs) {
        await dispatchToAllChannels(
          target,
          {
            subject: `Все още незавършена: ${task.title}`,
            body: `Напомняне за задача с по-дълъг срок — краен срок ${formatDateTime(task.deadline)}.`,
            deadline: task.deadline,
          },
          { taskId: task.id }
        );
        await prisma.task.update({ where: { id: task.id }, data: { lastPeriodicReminderAt: now } });
      }
    }
  }
}

async function handleOverdueTasks(now: Date): Promise<void> {
  const overdue = await prisma.task.findMany({
    where: {
      deletedAt: null,
      status: { in: OPEN_STATUSES as unknown as string[] },
      deadline: { lt: now },
    },
    include: { assignee: true },
  });

  for (const task of overdue) {
    const rule = await pickRuleForUser(task.assigneeId);
    if (!rule) continue; // No fine rule configured for this account; still mark overdue below.

    const rawHoursLate = hoursBetween(task.deadline, now);
    const pausedHours = await leaveHoursOverlap(task.assigneeId, task.deadline, now);
    const hoursLate = Math.max(0, rawHoursLate - pausedHours);
    const { daysLate, amount, currency } = calculateFine(hoursLate, rule);

    const wasAlreadyOverdue = task.status === "OVERDUE";
    const isNewEscalationDay = daysLate > (task.lastFinedDaysLate ?? 0);

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
      await prisma.task.update({ where: { id: task.id }, data: { lastEscalationAt: now, lastFinedDaysLate: daysLate } });

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
 * Mirrors sendUpcomingReminders, but for the Owner's review window instead
 * of the assignee's task deadline:
 *  - a repeating "still waiting on you" nudge every
 *    REVIEW_REMINDER_PERIODIC_HOURS (default 4h) from the moment it was
 *    submitted, while more than REVIEW_REMINDER_FINAL_HOURS_BEFORE remains;
 *  - a one-off final reminder once REVIEW_REMINDER_FINAL_HOURS_BEFORE
 *    (default 1h) remain before the review is considered late and starts
 *    accruing a fine.
 * Only fires while reviewDueAt is still in the future — once it passes,
 * handleOverdueReviews takes over with fines instead of reminders.
 */
async function sendUpcomingReviewReminders(now: Date): Promise<void> {
  const finalMs = env.reviewReminderFinalHoursBefore * 60 * 60 * 1000;
  const periodicMs = env.reviewReminderPeriodicHours * 60 * 60 * 1000;

  const pendingReviews = await prisma.taskSubmission.findMany({
    where: { reviewStatus: "PENDING", reviewDueAt: { gt: now }, task: { deletedAt: null } },
    include: { task: { include: { owner: true } }, submittedBy: true },
  });

  for (const submission of pendingReviews) {
    const task = submission.task;
    if (!task.ownerId || !task.owner) continue;

    const timeToReviewDueMs = submission.reviewDueAt!.getTime() - now.getTime();
    const target = toNotificationTarget(task.owner);

    if (!submission.reviewFinalReminderSentAt && timeToReviewDueMs <= finalMs) {
      await dispatchToAllChannels(
        target,
        {
          subject: `Последно напомняне за преглед: ${task.title}`,
          body: `Остава под ${env.reviewReminderFinalHoursBefore} ${env.reviewReminderFinalHoursBefore === 1 ? "час" : "часа"} да прегледаш подадената задача "${task.title}" (изпълнител: ${submission.submittedBy.name}, срок за преглед ${formatDateTime(submission.reviewDueAt!)}). След това започва да ти се начислява глоба.`,
          deadline: submission.reviewDueAt!,
        },
        { taskId: task.id }
      );
      await prisma.taskSubmission.update({ where: { id: submission.id }, data: { reviewFinalReminderSentAt: now } });
      continue;
    }

    const lastPeriodic = (submission.lastPeriodicReviewReminderAt ?? submission.createdAt).getTime();
    if (now.getTime() - lastPeriodic >= periodicMs) {
      await dispatchToAllChannels(
        target,
        {
          subject: `Чака преглед: ${task.title}`,
          body: `Все още имаш чакаща за преглед задача "${task.title}" (изпълнител: ${submission.submittedBy.name}, срок за преглед ${formatDateTime(submission.reviewDueAt!)}).`,
          deadline: submission.reviewDueAt!,
        },
        { taskId: task.id }
      );
      await prisma.taskSubmission.update({ where: { id: submission.id }, data: { lastPeriodicReviewReminderAt: now } });
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
    where: { reviewStatus: "PENDING", reviewDueAt: { lt: now }, task: { deletedAt: null } },
    include: { task: { include: { owner: true } } },
  });

  for (const submission of pendingReviews) {
    const task = submission.task;
    if (!task.ownerId || !task.owner) continue; // No owner assigned; nothing to fine.

    const rule = await pickRuleForUser(task.ownerId);
    if (!rule) continue;

    const rawHoursLate = hoursBetween(submission.reviewDueAt!, now);
    const pausedHours = await leaveHoursOverlap(task.ownerId, submission.reviewDueAt!, now);
    const hoursLate = Math.max(0, rawHoursLate - pausedHours);
    const { daysLate, amount, currency } = calculateFine(hoursLate, rule);
    if (amount <= 0) continue;

    const priorDaysLate = submission.reviewLastFinedDaysLate ?? 0;
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
    await prisma.taskSubmission.update({
      where: { id: submission.id },
      data: { reviewLastEscalationAt: now, reviewLastFinedDaysLate: daysLate },
    });

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
