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
  // Measured in BUSINESS hours now, not wall-clock — see businessHours.ts.
  // A submission outside the 9-18 window starts its clock at the next
  // working day's opening instead of ticking overnight/over the weekend.
  reviewDueHours: Number(process.env.REVIEW_DUE_HOURS ?? 24),
  reviewBusinessStartHour: Number(process.env.REVIEW_BUSINESS_START_HOUR ?? 9),
  reviewBusinessEndHour: Number(process.env.REVIEW_BUSINESS_END_HOUR ?? 18),
  // How often to nudge the Owner about a submission still waiting on them,
  // and how long before reviewDueAt to send the last "about to be fined" heads-up.
  reviewReminderPeriodicHours: Number(process.env.REVIEW_REMINDER_PERIODIC_HOURS ?? 4),
  reviewReminderFinalHoursBefore: Number(process.env.REVIEW_REMINDER_FINAL_HOURS_BEFORE ?? 1),
  // Weekly and monthly templates warrant different advance notice — a
  // monthly task is easy to forget over a longer gap, a weekly one doesn't
  // need as much lead time — so these are separate knobs, not one shared
  // default applied to both.
  recurringLookaheadDaysWeekly: Number(process.env.RECURRING_LOOKAHEAD_DAYS_WEEKLY ?? 3),
  recurringLookaheadDaysMonthly: Number(process.env.RECURRING_LOOKAHEAD_DAYS_MONTHLY ?? 10),
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
  // Override points for local/CI testing against a mock server — never set
  // in production, where these just default to the real Google endpoints.
  googleOauthBaseUrl: process.env.GOOGLE_OAUTH_BASE_URL ?? "https://oauth2.googleapis.com",
  googleDriveApiBaseUrl: process.env.GOOGLE_DRIVE_API_BASE_URL ?? "https://www.googleapis.com",
  // Drive folder Meet auto-saves its recordings/transcripts into — must
  // match the folder name exactly as it appears in the account's Drive.
  googleMeetFolderName: process.env.GOOGLE_MEET_FOLDER_NAME ?? "Meet Recordings",
  // How often to poll that folder for new files, and how many to process
  // (transcribe + extract) in a single poll cycle.
  googleMeetPollCron: process.env.GOOGLE_MEET_POLL_CRON ?? "*/10 * * * *",
  googleMeetMaxPerPoll: Number(process.env.GOOGLE_MEET_MAX_PER_POLL ?? 5),

  // Voice-to-tasks (see src/lib/whisper.ts, src/lib/taskExtraction.ts).
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  // Override points for local/CI testing against a mock server — never set
  // in production, where these just default to the real APIs.
  openaiApiBaseUrl: process.env.OPENAI_API_BASE_URL ?? "https://api.openai.com",
  anthropicApiBaseUrl: process.env.ANTHROPIC_API_BASE_URL ?? "https://api.anthropic.com",
  // Files under this size are transcribed synchronously within the request;
  // larger ones go through the VoiceProcessingJob background path instead.
  voiceSyncMaxBytes: Number(process.env.VOICE_SYNC_MAX_BYTES ?? 10 * 1024 * 1024),
  // Fallback deadline (working days out, weekends/BG holidays skipped) when
  // Claude's extraction doesn't return a usable date for a task.
  voiceDefaultDeadlineWorkingDays: Number(process.env.VOICE_DEFAULT_DEADLINE_WORKING_DAYS ?? 3),
};
