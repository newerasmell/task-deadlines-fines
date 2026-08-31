import { env } from "../lib/env";
import { ChannelSendResult, NotificationChannelAdapter, NotificationMessage, NotificationTarget } from "./types";

/**
 * Creates a Google Calendar event for the task deadline (and reminder pop-ups)
 * on the shared/admin calendar configured via GOOGLE_REFRESH_TOKEN. This is
 * intentionally simple: one OAuth2 app-level connection (set up once by the
 * admin) rather than per-employee OAuth, since most small teams share one
 * "Deadlines" calendar. See README for the OAuth setup flow.
 */
export class GoogleCalendarAdapter implements NotificationChannelAdapter {
  readonly channel = "GOOGLE_CALENDAR" as const;

  isConfigured(): boolean {
    return Boolean(
      env.googleClientId && env.googleClientSecret && env.googleRefreshToken
    );
  }

  hasTarget(target: NotificationTarget): boolean {
    // Calendar events aren't per-channel-identity; any assigned user counts,
    // as long as we have a deadline to schedule.
    return true;
  }

  private async getAccessToken(): Promise<string> {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.googleClientId,
        client_secret: env.googleClientSecret,
        refresh_token: env.googleRefreshToken,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to refresh Google OAuth token: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { access_token: string };
    return json.access_token;
  }

  async send(target: NotificationTarget, message: NotificationMessage): Promise<ChannelSendResult> {
    if (!this.isConfigured()) {
      return { channel: this.channel, status: "SKIPPED", error: "Google OAuth env vars not set" };
    }
    if (!message.deadline) {
      return { channel: this.channel, status: "SKIPPED", error: "No deadline on this message" };
    }

    const calendarId = target.googleCalendarId || "primary";

    try {
      const accessToken = await this.getAccessToken();
      const start = message.deadline;
      const end = new Date(start.getTime() + 30 * 60 * 1000);

      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            summary: `[Срок] ${message.subject} — ${target.name}`,
            description: message.body,
            start: { dateTime: start.toISOString() },
            end: { dateTime: end.toISOString() },
            reminders: {
              useDefault: false,
              overrides: [
                { method: "popup", minutes: 60 },
                { method: "popup", minutes: 24 * 60 },
              ],
            },
          }),
        }
      );
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
