import { env } from "../lib/env";
import { NotificationMessage } from "./types";

/**
 * Fire-and-forget broadcast to an admin Telegram group and/or a dedicated
 * admin Slack channel, independent of any single user's own notification
 * channels. Used so admins see every significant event in the system
 * (task created, submitted, approved/rejected, fined, waived, overdue)
 * without needing to be the assignee/owner of each one.
 */
export async function broadcastToAdmins(message: NotificationMessage): Promise<void> {
  const text = `${message.subject}\n${message.body}`;

  const jobs: Promise<void>[] = [];

  if (env.adminTelegramChatId) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.adminTelegramChatId, text }),
      })
        .then((res) => {
          if (!res.ok) {
            return res.text().then((body) => {
              console.error(`[adminBroadcast] Telegram failed: HTTP ${res.status}: ${body}`);
            });
          }
        })
        .catch((err) => console.error("[adminBroadcast] Telegram error:", err))
    );
  }

  if (env.adminSlackWebhookUrl) {
    jobs.push(
      fetch(env.adminSlackWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `*${message.subject}*\n${message.body}` }),
      })
        .then((res) => {
          if (!res.ok) {
            console.error(`[adminBroadcast] Slack failed: HTTP ${res.status}`);
          }
        })
        .catch((err) => console.error("[adminBroadcast] Slack error:", err))
    );
  }

  await Promise.all(jobs);
}
