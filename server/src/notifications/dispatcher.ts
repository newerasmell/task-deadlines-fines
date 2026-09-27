import { isWithinBusinessHours, nextBusinessWindowStart } from "../lib/businessHours";
import { prisma } from "../lib/prisma";
import { EmailAdapter } from "./email";
import { GoogleCalendarAdapter } from "./googleCalendar";
import { SlackAdapter } from "./slack";
import { TelegramAdapter } from "./telegram";
import { ChannelSendResult, NotificationChannelAdapter, NotificationMessage, NotificationTarget } from "./types";
import { ViberAdapter } from "./viber";
import { WhatsAppAdapter } from "./whatsapp";

const adapters: NotificationChannelAdapter[] = [
  new TelegramAdapter(),
  new SlackAdapter(),
  new EmailAdapter(),
  new WhatsAppAdapter(),
  new ViberAdapter(),
  new GoogleCalendarAdapter(),
];

export function getAdapters(): NotificationChannelAdapter[] {
  return adapters;
}

export interface DispatchOptions {
  taskId?: string;
}

/**
 * Sends `message` to `target` over every configured channel that the target
 * has an identity for, logging each attempt to NotificationLog.
 */
export async function dispatchToAllChannels(
  target: NotificationTarget,
  message: NotificationMessage,
  options: DispatchOptions = {}
): Promise<ChannelSendResult[]> {
  const results: ChannelSendResult[] = [];

  for (const adapter of adapters) {
    if (!adapter.isConfigured() || !adapter.hasTarget(target)) {
      continue;
    }
    const result = await adapter.send(target, message);
    results.push(result);

    await prisma.notificationLog.create({
      data: {
        taskId: options.taskId,
        userId: target.userId,
        channel: adapter.channel,
        status: result.status,
        message: `${message.subject}\n${message.body}`,
        error: result.error,
      },
    });
  }

  return results;
}

export function toNotificationTarget(user: {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  telegramChatId: string | null;
  slackMemberId: string | null;
  whatsappPhone: string | null;
  viberUserId: string | null;
  googleCalendarId: string | null;
  businessHoursOnly: boolean;
}): NotificationTarget {
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    telegramChatId: user.telegramChatId,
    slackMemberId: user.slackMemberId,
    whatsappPhone: user.whatsappPhone,
    viberUserId: user.viberUserId,
    googleCalendarId: user.googleCalendarId,
    businessHoursOnly: user.businessHoursOnly,
  };
}

/**
 * The gate every real "notify this person" call site should go through
 * (dispatchToAllChannels itself stays a plain, immediate send — it's also
 * what the scheduler uses to actually deliver a held notification once its
 * window opens, so it can't defer to itself). A target without
 * businessHoursOnly sends exactly as before; one with it set gets sent now
 * if we're already inside the team's business window, or held in
 * ScheduledNotification for the next window's opening otherwise — see
 * runScheduledNotificationDelivery for the other half of this.
 */
export async function dispatchRespectingBusinessHours(
  target: NotificationTarget,
  message: NotificationMessage,
  options: DispatchOptions = {}
): Promise<ChannelSendResult[]> {
  const now = new Date();
  if (target.businessHoursOnly && !isWithinBusinessHours(now)) {
    await prisma.scheduledNotification.create({
      data: {
        userId: target.userId,
        taskId: options.taskId,
        subject: message.subject,
        body: message.body,
        deadline: message.deadline,
        sendAfter: nextBusinessWindowStart(now),
      },
    });
    return [];
  }
  return dispatchToAllChannels(target, message, options);
}
