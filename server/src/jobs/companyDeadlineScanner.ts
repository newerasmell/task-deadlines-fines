import type { User } from "@prisma/client";
import { formatDateTime } from "../lib/dateFormat";
import { prisma } from "../lib/prisma";
import { dispatchRespectingBusinessHours, toNotificationTarget } from "../notifications/dispatcher";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function amountLine(item: { amount: number | null; currency: string | null }): string {
  return item.amount ? `\nСума: ${item.amount} ${item.currency ?? "EUR"}` : "";
}

function companyLine(item: { company: string; jurisdiction: string }): string {
  return `${item.company} (${item.jurisdiction})\n`;
}

/**
 * Same reminder-tier mechanics as subscriptionScanner.ts, but recipients are
 * every active super admin ("мастър акаунтите"), resolved fresh on each
 * scan rather than a stored assignee — this tracks per-company filing
 * obligations across the whole corporate group, not a per-employee item.
 */
export async function runCompanyDeadlineScan(now: Date = new Date()): Promise<void> {
  const [items, masters] = await Promise.all([
    prisma.companyDeadline.findMany({ where: { status: "ACTIVE" } }),
    prisma.user.findMany({ where: { isSuperAdmin: true, active: true } }),
  ]);
  if (masters.length === 0) return;

  for (const item of items) {
    const daysRemaining = (item.dueDate.getTime() - now.getTime()) / DAY_MS;
    const isDueDay = sameCalendarDay(now, item.dueDate);

    if (isDueDay) {
      const last = item.lastPeriodicReminderAt?.getTime() ?? 0;
      if (now.getTime() - last < 2 * HOUR_MS) continue;
      await notify(
        masters,
        `Днес изтича срокът: ${item.title}`,
        `${companyLine(item)}Днес е крайният срок за "${item.title}" (${formatDateTime(item.dueDate)}).${amountLine(item)}`
      );
      await prisma.companyDeadline.update({ where: { id: item.id }, data: { lastPeriodicReminderAt: now } });
      continue;
    }

    if (daysRemaining <= 7) {
      const last = item.lastDailyReminderAt?.getTime() ?? 0;
      if (now.getTime() - last < 20 * HOUR_MS) continue;
      const daysLate = Math.round(-daysRemaining);
      const subject = daysRemaining < 0 ? `Просрочено: ${item.title}` : `Наближава срок: ${item.title}`;
      const body =
        daysRemaining < 0
          ? `${companyLine(item)}"${item.title}" просрочи срока си (${formatDateTime(item.dueDate)}) с ${daysLate} ${daysLate === 1 ? "ден" : "дни"}.${amountLine(item)}`
          : `${companyLine(item)}Остават ${Math.ceil(daysRemaining)} ${Math.ceil(daysRemaining) === 1 ? "ден" : "дни"} до крайния срок за "${item.title}" (${formatDateTime(item.dueDate)}).${amountLine(item)}`;
      await notify(masters, subject, body);
      await prisma.companyDeadline.update({ where: { id: item.id }, data: { lastDailyReminderAt: now } });
      continue;
    }

    if (daysRemaining <= 15 && !item.reminder15dSentAt) {
      await notify(
        masters,
        `Наближава срок (15 дни): ${item.title}`,
        `${companyLine(item)}Остават 15 дни до крайния срок за "${item.title}" (${formatDateTime(item.dueDate)}).${amountLine(item)}`
      );
      await prisma.companyDeadline.update({ where: { id: item.id }, data: { reminder15dSentAt: now } });
      continue;
    }

    if (daysRemaining <= 30 && !item.reminder30dSentAt) {
      await notify(
        masters,
        `Наближава срок (1 месец): ${item.title}`,
        `${companyLine(item)}Остава 1 месец до крайния срок за "${item.title}" (${formatDateTime(item.dueDate)}).${amountLine(item)}`
      );
      await prisma.companyDeadline.update({ where: { id: item.id }, data: { reminder30dSentAt: now } });
      continue;
    }
  }
}

async function notify(masters: User[], subject: string, body: string): Promise<void> {
  for (const master of masters) {
    await dispatchRespectingBusinessHours(toNotificationTarget(master), { subject, body });
  }
}
