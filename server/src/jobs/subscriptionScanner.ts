import { formatDateTime } from "../lib/dateFormat";
import { prisma } from "../lib/prisma";
import { dispatchToAllChannels, toNotificationTarget } from "../notifications/dispatcher";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

type Recipient = { id: string; name: string; email: string; phone: string | null; telegramChatId: string | null; slackMemberId: string | null; whatsappPhone: string | null; viberUserId: string | null; googleCalendarId: string | null };

function dedupeRecipients(users: (Recipient | null)[]): Recipient[] {
  const byId = new Map<string, Recipient>();
  for (const u of users) if (u) byId.set(u.id, u);
  return [...byId.values()];
}

/**
 * Reminder tiers for a tracked subscription/renewal — entirely separate
 * from Task/Fine, no fines involved. Checked most-urgent-first per item so
 * a single scan only ever fires one tier, same style as the Task deadline
 * reminders in deadlineScanner.ts:
 *  - every 2 hours, specifically on the due date's own calendar day;
 *  - otherwise daily, from 7 days out and for as long as it stays ACTIVE
 *    afterwards (including past the due date, so it never goes silent);
 *  - a one-off nudge at 15 days out;
 *  - a one-off nudge at 30 days out.
 */
export async function runSubscriptionScan(now: Date = new Date()): Promise<void> {
  const items = await prisma.subscription.findMany({
    where: { status: "ACTIVE" },
    include: { assignee: true, owner: true },
  });

  for (const item of items) {
    const recipients = dedupeRecipients([item.assignee, item.owner]);
    if (recipients.length === 0) continue;

    const daysRemaining = (item.dueDate.getTime() - now.getTime()) / DAY_MS;
    const isDueDay = sameCalendarDay(now, item.dueDate);

    if (isDueDay) {
      const last = item.lastPeriodicReminderAt?.getTime() ?? 0;
      if (now.getTime() - last < 2 * HOUR_MS) continue;
      await notify(item, recipients, `Днес изтича срокът: ${item.title}`, `Днес е крайният срок за "${item.title}" (${formatDateTime(item.dueDate)}).${amountLine(item)}`);
      await prisma.subscription.update({ where: { id: item.id }, data: { lastPeriodicReminderAt: now } });
      continue;
    }

    if (daysRemaining <= 7) {
      const last = item.lastDailyReminderAt?.getTime() ?? 0;
      if (now.getTime() - last < 20 * HOUR_MS) continue;
      const daysLate = Math.round(-daysRemaining);
      const subject = daysRemaining < 0 ? `Просрочено: ${item.title}` : `Наближава срок: ${item.title}`;
      const body =
        daysRemaining < 0
          ? `"${item.title}" просрочи срока си (${formatDateTime(item.dueDate)}) с ${daysLate} ${daysLate === 1 ? "ден" : "дни"}.${amountLine(item)}`
          : `Остават ${Math.ceil(daysRemaining)} ${Math.ceil(daysRemaining) === 1 ? "ден" : "дни"} до крайния срок за "${item.title}" (${formatDateTime(item.dueDate)}).${amountLine(item)}`;
      await notify(item, recipients, subject, body);
      await prisma.subscription.update({ where: { id: item.id }, data: { lastDailyReminderAt: now } });
      continue;
    }

    if (daysRemaining <= 15 && !item.reminder15dSentAt) {
      await notify(item, recipients, `Наближава срок (15 дни): ${item.title}`, `Остават 15 дни до крайния срок за "${item.title}" (${formatDateTime(item.dueDate)}).${amountLine(item)}`);
      await prisma.subscription.update({ where: { id: item.id }, data: { reminder15dSentAt: now } });
      continue;
    }

    if (daysRemaining <= 30 && !item.reminder30dSentAt) {
      await notify(item, recipients, `Наближава срок (1 месец): ${item.title}`, `Остава 1 месец до крайния срок за "${item.title}" (${formatDateTime(item.dueDate)}).${amountLine(item)}`);
      await prisma.subscription.update({ where: { id: item.id }, data: { reminder30dSentAt: now } });
      continue;
    }
  }
}

function amountLine(item: { amount: number | null; currency: string | null }): string {
  return item.amount ? `\nСума: ${item.amount} ${item.currency ?? "EUR"}` : "";
}

async function notify(
  item: { id: string },
  recipients: Recipient[],
  subject: string,
  body: string
): Promise<void> {
  for (const recipient of recipients) {
    await dispatchToAllChannels(toNotificationTarget(recipient), { subject, body });
  }
}
