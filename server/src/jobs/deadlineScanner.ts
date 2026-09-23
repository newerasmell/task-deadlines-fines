import { deadlineFallsOnWeekend, nonWorkingHoursBetween } from "../lib/bulgarianHolidays";
import { businessHoursBetween, isWithinBusinessHours } from "../lib/businessHours";
import { formatDateTime } from "../lib/dateFormat";
import { env } from "../lib/env";
import { isOnLeave } from "../lib/leave";
import { prisma } from "../lib/prisma";
import { broadcastToAdmins } from "../notifications/adminBroadcast";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";
import { calculateFine, hoursBetween } from "../services/fineCalculator";
import { spawnRecurringOccurrences } from "./recurringTasks";

export const OPEN_STATUSES = ["PENDING", "IN_PROGRESS", "OVERDUE"] as const;

// How many hours of the [from, to) window fall inside an approved Leave for
// this person — subtracted from their lateness before a fine is computed,
// so nobody accrues a fine (or an escalating one) for time they were
// pre-approved to be away. Used for the assignee's task-deadline fine below,
// alongside nonWorkingHoursBetween (weekends + BG holidays), which pauses
// the same clock for everyone — unless the task's own deadline was itself
// set for a Saturday or Sunday, in which case that task is a deliberate
// exception: its clock runs straight through weekends/holidays with no
// pause at all. Leave still applies to an exception task; only the
// weekend/holiday pause is skipped. (The review-deadline path below uses
// businessHoursLateExcludingLeave instead — see that function's own doc.)
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

// Genuine lateness on a review deadline: businessHoursBetween already
// excludes evenings/nights/weekends/holidays (reviewDueAt itself was placed
// on a business boundary by addBusinessHours, so only business time after
// it should ever count), and this additionally excludes any of that
// business time the Owner was on approved Leave for — same reasoning as
// leaveHoursOverlap above, just measured in business hours instead of raw
// wall-clock ones so the two don't get mixed.
async function businessHoursLateExcludingLeave(userId: string, from: Date, to: Date): Promise<number> {
  if (to <= from) return 0;
  let hours = businessHoursBetween(from, to);
  const leaves = await prisma.leave.findMany({
    where: { userId, startDate: { lt: to }, endDate: { gt: from } },
  });
  for (const leave of leaves) {
    const start = leave.startDate > from ? leave.startDate : from;
    const end = leave.endDate < to ? leave.endDate : to;
    hours -= businessHoursBetween(start, end);
  }
  return Math.max(0, hours);
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
    // A reminder exists to prod someone into finishing before a deadline —
    // sending it while they're on approved leave just interrupts a day
    // they're not working. Skipping here (rather than also marking it
    // sent) means it isn't lost either: it fires normally on the first
    // scan after they're back, same as if this task had just become due.
    if (await isOnLeave(task.assigneeId, now)) continue;

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
    include: { assignee: true, template: { select: { active: true } } },
  });

  for (const task of overdue) {
    // Deactivating/deleting a recurring template cancels the OPEN
    // occurrences it has at that moment (see taskTemplatesRouter), but a
    // task can be reopened into an OPEN_STATUSES status again afterward
    // through an unrelated path (e.g. a submitted-for-review occurrence
    // whose review later gets rejected) with no re-check of whether its
    // template is still around. Checked fresh on every scan instead of
    // only at deactivate/delete time, so no matter which path reopened
    // it, an orphaned occurrence self-heals to CANCELLED here instead of
    // resuming its daily fine — confirmed live as the actual mechanism
    // behind a fine that kept recurring on a task whose recurring series
    // had already been stopped.
    if (task.templateId && task.template && !task.template.active) {
      await prisma.task.update({ where: { id: task.id }, data: { status: "CANCELLED" } });
      continue;
    }

    const rule = await pickRuleForUser(task.assigneeId);
    if (!rule) continue; // No fine rule configured for this account; still mark overdue below.

    const rawHoursLate = hoursBetween(task.deadline, now);
    const leavePausedHours = await leaveHoursOverlap(task.assigneeId, task.deadline, now);
    const pausedHours = deadlineFallsOnWeekend(task.deadline)
      ? leavePausedHours
      : leavePausedHours + nonWorkingHoursBetween(task.deadline, now);
    const hoursLate = Math.max(0, rawHoursLate - pausedHours);
    const { daysLate, amount, currency } = calculateFine(hoursLate, rule);

    const wasAlreadyOverdue = task.status === "OVERDUE";
    const isNewEscalationDay = daysLate > (task.lastFinedDaysLate ?? 0);

    if (!wasAlreadyOverdue) {
      await prisma.task.update({ where: { id: task.id }, data: { status: "OVERDUE" } });
    }

    if (amount > 0 && isNewEscalationDay) {
      // `amount` is the rule's cumulative total for being `daysLate` days
      // late (base + perDay * extra days, capped). Only the increase since
      // the last fine actually gets charged now — otherwise a "50 base + 50
      // /day" rule would charge 50 on day 1 and a NEW 100 on day 2 instead
      // of a further 50, double-counting day 1's charge.
      const incrementalAmount = Math.round((amount - (task.lastFinedAmount ?? 0)) * 100) / 100;
      await prisma.task.update({
        where: { id: task.id },
        data: { lastEscalationAt: now, lastFinedDaysLate: daysLate, lastFinedAmount: amount },
      });
      if (incrementalAmount <= 0) continue; // Cap already reached; nothing new to charge.

      const fine = await prisma.fine.create({
        data: {
          taskId: task.id,
          userId: task.assigneeId,
          amount: incrementalAmount,
          currency,
          daysLate,
          reason: `Неоснователно закъснение по задача "${task.title}" (${daysLate} ${daysLate === 1 ? "ден" : "дни"} закъснение)`,
        },
      });

      // The fine itself still applies — leaveHoursOverlap above already
      // excluded actual leave time from hoursLate, so a fine landing here
      // reflects genuine lateness outside that window. Only the personal
      // ping is held back while they're away; admins still hear about it.
      if (!(await isOnLeave(task.assigneeId, now))) {
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
 *
 * Both nudges are also held to the team's business window (9:00-18:00,
 * Mon-Fri, minus BG holidays — same window addBusinessHours already places
 * reviewDueAt on) — confirmed live: without this, the periodic nudge kept
 * firing straight through the night and weekend on its raw 4h wall-clock
 * cadence, waking an Owner up long after they could act on it. Skipping
 * here (rather than also marking it sent) means it isn't lost, just
 * deferred: it fires on the first scan once business hours resume, which
 * lands it right at the start of the Owner's working day.
 */
async function sendUpcomingReviewReminders(now: Date): Promise<void> {
  const finalMs = env.reviewReminderFinalHoursBefore * 60 * 60 * 1000;
  const periodicMs = env.reviewReminderPeriodicHours * 60 * 60 * 1000;

  if (!isWithinBusinessHours(now)) return;

  const pendingReviews = await prisma.taskSubmission.findMany({
    where: { reviewStatus: "PENDING", reviewDueAt: { gt: now }, task: { deletedAt: null, status: "PENDING_REVIEW" } },
    include: { task: { include: { owner: true } }, submittedBy: true },
  });

  for (const submission of pendingReviews) {
    const task = submission.task;
    if (!task.ownerId || !task.owner) continue;
    // Same reasoning as the assignee reminders above: skip without marking
    // it sent, so it resumes normally once the Owner is back from leave.
    if (await isOnLeave(task.ownerId, now)) continue;

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
 *
 * Gated on task.status === "PENDING_REVIEW", not just the submission's own
 * reviewStatus — a task that got closed some other way (e.g. an admin
 * editing its status directly to DONE, instead of going through approve/
 * reject or the dedicated "close" action) would otherwise leave its
 * submission stuck at reviewStatus "PENDING" forever, and this scan would
 * keep fining the Owner daily for a task that's actually already done.
 */
async function handleOverdueReviews(now: Date): Promise<void> {
  const pendingReviews = await prisma.taskSubmission.findMany({
    where: { reviewStatus: "PENDING", reviewDueAt: { lt: now }, task: { deletedAt: null, status: "PENDING_REVIEW" } },
    include: { task: { include: { owner: true, template: { select: { active: true } } } } },
  });

  for (const submission of pendingReviews) {
    const task = submission.task;

    // Same self-heal as handleOverdueTasks — a review this late on an
    // occurrence whose recurring series is already gone isn't a live
    // obligation for the Owner anymore either.
    if (task.templateId && task.template && !task.template.active) {
      await prisma.task.update({ where: { id: task.id }, data: { status: "CANCELLED" } });
      continue;
    }

    if (!task.ownerId || !task.owner) continue; // No owner assigned; nothing to fine.

    const rule = await pickRuleForUser(task.ownerId);
    if (!rule) continue;

    const hoursLate = await businessHoursLateExcludingLeave(task.ownerId, submission.reviewDueAt!, now);
    const { daysLate, amount, currency } = calculateFine(hoursLate, rule);
    if (amount <= 0) continue;

    const priorDaysLate = submission.reviewLastFinedDaysLate ?? 0;
    if (daysLate <= priorDaysLate) continue;

    // Same incremental-charge fix as handleOverdueTasks: `amount` is the
    // cumulative total for `daysLate` days late, so only the increase since
    // the last review fine gets charged now.
    const incrementalAmount = Math.round((amount - (submission.reviewLastFinedAmount ?? 0)) * 100) / 100;
    await prisma.taskSubmission.update({
      where: { id: submission.id },
      data: { reviewLastEscalationAt: now, reviewLastFinedDaysLate: daysLate, reviewLastFinedAmount: amount },
    });
    if (incrementalAmount <= 0) continue; // Cap already reached; nothing new to charge.

    const fine = await prisma.fine.create({
      data: {
        taskId: task.id,
        userId: task.ownerId,
        amount: incrementalAmount,
        currency,
        daysLate,
        reason: `Забавен преглед на подадена задача "${task.title}" (${daysLate} ${daysLate === 1 ? "ден" : "дни"} закъснение на прегледа)`,
      },
    });

    // Same split as handleOverdueTasks: the fine stands (leaveHoursOverlap
    // above already excluded real leave time), only the personal ping to
    // the Owner is held back while they're away.
    if (!(await isOnLeave(task.ownerId, now))) {
      await dispatchToAllChannels(toNotificationTarget(task.owner), {
        subject: "Забавен преглед и наложена глоба",
        body: `Все още не си прегледал подадената задача "${task.title}". Просрочие на прегледа: ${daysLate} ${daysLate === 1 ? "ден" : "дни"}. Наложена глоба: ${fine.amount} ${fine.currency}.`,
      });
    }
    await broadcastToAdmins({
      subject: "Забавен преглед и глоба",
      body: `Owner ${task.owner.name} не прегледа "${task.title}" навреме — ${daysLate} ${daysLate === 1 ? "ден" : "дни"} закъснение, глоба ${fine.amount} ${fine.currency}.`,
    });
  }
}
