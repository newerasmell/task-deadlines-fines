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
  schedulerCron: process.env.SCHEDULER_CRON ?? "*/5 * * * *",
  reminderHoursBefore: Number(process.env.REMINDER_HOURS_BEFORE ?? 24),

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
