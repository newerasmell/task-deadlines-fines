import { env } from "../lib/env";
import { ChannelSendResult, NotificationChannelAdapter, NotificationMessage, NotificationTarget } from "./types";

export class SlackAdapter implements NotificationChannelAdapter {
  readonly channel = "SLACK" as const;

  isConfigured(): boolean {
    return Boolean(env.slackWebhookUrl) || Boolean(env.slackBotToken);
  }

  hasTarget(target: NotificationTarget): boolean {
    // A webhook posts to a fixed channel regardless of the target, so it's
    // always usable once configured; a bot token needs the member id for a DM.
    return Boolean(env.slackWebhookUrl) || Boolean(target.slackMemberId);
  }

  async send(target: NotificationTarget, message: NotificationMessage): Promise<ChannelSendResult> {
    if (!this.isConfigured()) {
      return { channel: this.channel, status: "SKIPPED", error: "SLACK_WEBHOOK_URL / SLACK_BOT_TOKEN not set" };
    }

    const text = `*${message.subject}* (${target.name})\n${message.body}`;

    // Prefer a direct message via the bot token if we have the member id.
    if (env.slackBotToken && target.slackMemberId) {
      try {
        const openRes = await fetch("https://slack.com/api/conversations.open", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.slackBotToken}`,
          },
          body: JSON.stringify({ users: target.slackMemberId }),
        });
        const openJson = (await openRes.json()) as { ok: boolean; channel?: { id: string }; error?: string };
        if (!openJson.ok || !openJson.channel) {
          return { channel: this.channel, status: "FAILED", error: openJson.error ?? "conversations.open failed" };
        }
        const postRes = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.slackBotToken}`,
          },
          body: JSON.stringify({ channel: openJson.channel.id, text }),
        });
        const postJson = (await postRes.json()) as { ok: boolean; error?: string };
        if (!postJson.ok) {
          return { channel: this.channel, status: "FAILED", error: postJson.error ?? "chat.postMessage failed" };
        }
        return { channel: this.channel, status: "SENT" };
      } catch (err) {
        return { channel: this.channel, status: "FAILED", error: (err as Error).message };
      }
    }

    if (env.slackWebhookUrl) {
      try {
        const res = await fetch(env.slackWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) {
          return { channel: this.channel, status: "FAILED", error: `HTTP ${res.status}` };
        }
        return { channel: this.channel, status: "SENT" };
      } catch (err) {
        return { channel: this.channel, status: "FAILED", error: (err as Error).message };
      }
    }

    return { channel: this.channel, status: "SKIPPED", error: "No delivery method available for this user" };
  }
}
