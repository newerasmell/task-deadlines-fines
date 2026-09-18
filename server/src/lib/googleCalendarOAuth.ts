import jwt from "jsonwebtoken";
import { decrypt, encrypt } from "./crypto";
import { env } from "./env";
import { prisma } from "./prisma";

// Per-user "Push to Calendar" OAuth (distinct from the admin-level, single
// shared-refresh-token GoogleCalendarAdapter in notifications/googleCalendar.ts
// and the Drive integration in googleDrive.ts — both of those use ONE
// app-wide connection; this one is one connection per user, each to their
// own personal calendar).
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const STATE_PURPOSE = "google_calendar_connect";

export function isGoogleCalendarConfigured(): boolean {
  return Boolean(env.googleClientId && env.googleClientSecret && env.googleCalendarRedirectUri);
}

function requireConfig(): void {
  if (!isGoogleCalendarConfigured()) {
    throw new Error("Google Calendar OAuth is not configured on the server (GOOGLE_CLIENT_ID/SECRET/GOOGLE_CALENDAR_REDIRECT_URI).");
  }
}

// The redirect back from Google's consent screen is a real browser
// navigation, not a fetch our own Authorization header can ride along on —
// so instead of requireAuth, this short-lived signed token (same secret as
// login JWTs, separate purpose so it can never be replayed as a session
// token or vice versa) is how the callback route knows which user just
// finished consenting.
export function signOAuthState(userId: string): string {
  return jwt.sign({ purpose: STATE_PURPOSE, userId }, env.jwtSecret, { expiresIn: "10m" });
}

export function verifyOAuthState(state: string): string {
  const payload = jwt.verify(state, env.jwtSecret) as { purpose?: string; userId?: string };
  if (payload.purpose !== STATE_PURPOSE || !payload.userId) {
    throw new Error("Invalid OAuth state");
  }
  return payload.userId;
}

export function buildAuthUrl(userId: string): string {
  requireConfig();
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: env.googleCalendarRedirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // forces a refresh_token on every connect, not just the first ever consent
    state: signOAuthState(userId),
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function requestToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(`${env.googleOauthBaseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google OAuth token request failed: HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

// Exchanges the one-time `code` from the consent redirect for a refresh
// token, encrypts it, and stores it against the user — called once, right
// after the callback verifies `state`.
export async function connectUserAccount(userId: string, code: string): Promise<void> {
  requireConfig();
  const tokens = await requestToken(
    new URLSearchParams({
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: env.googleCalendarRedirectUri,
      grant_type: "authorization_code",
      code,
    })
  );
  if (!tokens.refresh_token) {
    // Confirmed this can happen live: Google only issues a fresh
    // refresh_token when `prompt=consent` actually re-shows the screen —
    // already-configured `access_type=offline&prompt=consent` above
    // should always get one, but a user who somehow short-circuits consent
    // (or an account-level policy) can still come back without one.
    throw new Error("Google не върна refresh token — опитай да се свържеш отново.");
  }
  await prisma.user.update({
    where: { id: userId },
    data: { googleRefreshToken: encrypt(tokens.refresh_token), googleConnectedAt: new Date() },
  });
}

export async function disconnectUserAccount(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { googleRefreshToken: null, googleConnectedAt: null },
  });
}

export class GoogleCalendarNotConnectedError extends Error {
  constructor() {
    super("Този потребител не е свързал Google Calendar.");
  }
}

// Thrown specifically when Google rejects the stored refresh token itself
// (revoked from the user's Google Account security settings, or expired) —
// distinct from a network/API failure, so the caller can clear the stale
// connection and tell the user to reconnect instead of just failing once.
export class GoogleCalendarTokenRevokedError extends Error {
  constructor() {
    super("Достъпът до Google Calendar е отменен — свържи отново от профила си.");
  }
}

async function getAccessTokenForUser(userId: string): Promise<string> {
  requireConfig();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { googleRefreshToken: true } });
  if (!user?.googleRefreshToken) throw new GoogleCalendarNotConnectedError();

  const refreshToken = decrypt(user.googleRefreshToken);
  try {
    const tokens = await requestToken(
      new URLSearchParams({
        client_id: env.googleClientId,
        client_secret: env.googleClientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      })
    );
    return tokens.access_token;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("invalid_grant")) {
      await disconnectUserAccount(userId);
      throw new GoogleCalendarTokenRevokedError();
    }
    throw err;
  }
}

export interface PushEventInput {
  userId: string;
  eventId: string | null; // existing task.googleEventId, or null to insert
  summary: string;
  description: string;
  start: Date;
  end: Date;
  reminderMinutesBefore: number;
}

// Insert or update (never duplicates) the event for one task, per the
// brief's idempotent-push requirement — `eventId` set means update.
export async function pushEventForUser(input: PushEventInput): Promise<string> {
  const accessToken = await getAccessTokenForUser(input.userId);
  const body = {
    summary: input.summary,
    description: input.description,
    start: { dateTime: input.start.toISOString() },
    end: { dateTime: input.end.toISOString() },
    reminders: {
      useDefault: false,
      overrides: [{ method: "popup", minutes: input.reminderMinutesBefore }],
    },
  };
  const url = input.eventId
    ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(input.eventId)}`
    : "https://www.googleapis.com/calendar/v3/calendars/primary/events";
  const res = await fetch(url, {
    method: input.eventId ? "PUT" : "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google Calendar event push failed: HTTP ${res.status} ${text}`);
  }
  const json = (await res.json()) as { id: string };
  return json.id;
}

export async function deleteEventForUser(userId: string, eventId: string): Promise<void> {
  const accessToken = await getAccessTokenForUser(userId);
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // 404/410 means it's already gone (deleted directly in Google Calendar by
  // the user, say) — treat that the same as a successful delete rather than
  // failing a request whose end state is exactly what was asked for.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google Calendar event delete failed: HTTP ${res.status} ${text}`);
  }
}
