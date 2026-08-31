export interface NotificationTarget {
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  telegramChatId: string | null;
  slackMemberId: string | null;
  whatsappPhone: string | null;
  viberUserId: string | null;
  googleCalendarId: string | null;
}

export interface NotificationMessage {
  subject: string;
  body: string;
  /** Optional deadline, used by channels that create calendar-style entries. */
  deadline?: Date;
}

export interface ChannelSendResult {
  channel: string;
  status: "SENT" | "FAILED" | "SKIPPED";
  error?: string;
}

export interface NotificationChannelAdapter {
  readonly channel:
    | "TELEGRAM"
    | "SLACK"
    | "EMAIL"
    | "WHATSAPP"
    | "VIBER"
    | "GOOGLE_CALENDAR";

  /** Whether this adapter has enough configuration to attempt sending. */
  isConfigured(): boolean;

  /** Whether the given target has the identifying info this channel needs. */
  hasTarget(target: NotificationTarget): boolean;

  send(target: NotificationTarget, message: NotificationMessage): Promise<ChannelSendResult>;
}
