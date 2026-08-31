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
  };
}
