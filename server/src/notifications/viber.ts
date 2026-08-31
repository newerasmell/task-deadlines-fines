import { env } from "../lib/env";
import { ChannelSendResult, NotificationChannelAdapter, NotificationMessage, NotificationTarget } from "./types";

/**
 * Uses the Viber REST Bot API. The target user must have already opted in
 * by messaging the bot at least once (Viber requires this before a bot can
 * push messages), which is when you capture their viberUserId. See README.
 */
export class ViberAdapter implements NotificationChannelAdapter {
  readonly channel = "VIBER" as const;

  isConfigured(): boolean {
    return Boolean(env.viberBotToken);
  }

  hasTarget(target: NotificationTarget): boolean {
    return Boolean(target.viberUserId);
  }

  async send(target: NotificationTarget, message: NotificationMessage): Promise<ChannelSendResult> {
    if (!this.isConfigured()) {
      return { channel: this.channel, status: "SKIPPED", error: "VIBER_BOT_TOKEN not set" };
    }
    if (!this.hasTarget(target)) {
      return { channel: this.channel, status: "SKIPPED", error: "User has no viberUserId" };
    }

    try {
      const res = await fetch("https://chatapi.viber.com/pa/send_message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Viber-Auth-Token": env.viberBotToken,
        },
        body: JSON.stringify({
          receiver: target.viberUserId,
          type: "text",
          text: `${message.subject}\n${message.body}`,
          sender: { name: "Task Deadlines" },
        }),
      });
      const json = (await res.json()) as { status: number; status_message: string };
      if (json.status !== 0) {
        return { channel: this.channel, status: "FAILED", error: json.status_message };
      }
      return { channel: this.channel, status: "SENT" };
    } catch (err) {
      return { channel: this.channel, status: "FAILED", error: (err as Error).message };
    }
  }
}
