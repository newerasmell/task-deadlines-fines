import "dotenv/config";

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: req("JWT_SECRET", "dev-secret-change-me"),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  // Timezone used to format dates/times in notification text — the server
  // itself typically runs in UTC (e.g. on Render), so without this every
  // notification would show times hours off from the team's actual clock.
  timezone: process.env.TZ_NAME ?? "Europe/Sofia",
  schedulerCron: process.env.SCHEDULER_CRON ?? "*/5 * * * *",
  reminderHoursBefore: Number(process.env.REMINDER_HOURS_BEFORE ?? 24),
  reminderFinalHoursBefore: Number(process.env.REMINDER_FINAL_HOURS_BEFORE ?? 4),
  reminderPeriodicHours: Number(process.env.REMINDER_PERIODIC_HOURS ?? 48),
  reviewDueHours: Number(process.env.REVIEW_DUE_HOURS ?? 24),
  // How often to nudge the Owner about a submission still waiting on them,
  // and how long before reviewDueAt to send the last "about to be fined" heads-up.
  reviewReminderPeriodicHours: Number(process.env.REVIEW_REMINDER_PERIODIC_HOURS ?? 4),
  reviewReminderFinalHoursBefore: Number(process.env.REVIEW_REMINDER_FINAL_HOURS_BEFORE ?? 1),
  recurringLookaheadDays: Number(process.env.RECURRING_LOOKAHEAD_DAYS ?? 3),
  uploadsDir: process.env.UPLOADS_DIR ?? "uploads",

  adminTelegramChatId: process.env.ADMIN_TELEGRAM_CHAT_ID ?? "",
  adminSlackWebhookUrl: process.env.ADMIN_SLACK_WEBHOOK_URL ?? "",

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",

  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL ?? "",
  slackBotToken: process.env.SLACK_BOT_TOKEN ?? "",

  smtpHost: process.env.SMTP_HOST ?? "",
  smtpPort: Number(process.env.SMTP_PORT ?? 465),
  smtpSecure: (process.env.SMTP_SECURE ?? "true") === "true",
  smtpUser: process.env.SMTP_USER ?? "",
  smtpPass: process.env.SMTP_PASS ?? "",
  smtpFrom: process.env.SMTP_FROM ?? "Task Deadlines <no-reply@example.com>",

  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? "",

  viberBotToken: process.env.VIBER_BOT_TOKEN ?? "",

  googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI ?? "",
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN ?? "",
};
