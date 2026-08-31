import { env } from "../lib/env";
import { ChannelSendResult, NotificationChannelAdapter, NotificationMessage, NotificationTarget } from "./types";

export class TelegramAdapter implements NotificationChannelAdapter {
  readonly channel = "TELEGRAM" as const;

  isConfigured(): boolean {
    return Boolean(env.telegramBotToken);
  }

  hasTarget(target: NotificationTarget): boolean {
    return Boolean(target.telegramChatId);
  }

  async send(target: NotificationTarget, message: NotificationMessage): Promise<ChannelSendResult> {
    if (!this.isConfigured()) {
      return { channel: this.channel, status: "SKIPPED", error: "TELEGRAM_BOT_TOKEN not set" };
    }
    if (!this.hasTarget(target)) {
      return { channel: this.channel, status: "SKIPPED", error: "User has no telegramChatId" };
    }

    const url = `https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`;
    const text = `*${escapeMd(message.subject)}*\n${escapeMd(message.body)}`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: target.telegramChatId,
          text,
          parse_mode: "MarkdownV2",
        }),
      });
      if (!res.ok) {
        const errBody = await res.text();
        return { channel: this.channel, status: "FAILED", error: `HTTP ${res.status}: ${errBody}` };
      }
      return { channel: this.channel, status: "SENT" };
    } catch (err) {
      return { channel: this.channel, status: "FAILED", error: (err as Error).message };
    }
  }
}

function escapeMd(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");
}
