import { randomBytes } from "crypto";
import { env } from "./env";
import { hashPassword } from "./auth";
import { EmailAdapter } from "../notifications/email";
import type { ChannelSendResult } from "../notifications/types";
import { prisma } from "./prisma";

const emailAdapter = new EmailAdapter();

// A new employee's account is created with no usable password at all —
// this placeholder hash is random and never revealed to anyone, so the
// account simply can't log in until the invite below is accepted. Kept
// separate from passwordHash's own NOT NULL constraint being touched.
export function placeholderPasswordHash(): Promise<string> {
  return hashPassword(randomBytes(32).toString("hex"));
}

// An invite link needs to survive the employee not checking their email
// same-day, unlike the 15-minute TTL the Telegram deep link uses.
const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createInvite(userId: string): Promise<string> {
  const token = randomBytes(24).toString("hex");
  await prisma.user.update({
    where: { id: userId },
    data: { inviteToken: token, inviteTokenExpiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS) },
  });
  return token;
}

export async function resolveInviteToken(token: string): Promise<{ id: string; name: string; email: string } | null> {
  return prisma.user.findFirst({
    where: { inviteToken: token, inviteTokenExpiresAt: { gt: new Date() } },
    select: { id: true, name: true, email: true },
  });
}

/**
 * Completes an invite: re-resolves the token itself (never trusts an
 * earlier resolve from the caller — the token could have expired or been
 * consumed in between) and sets the employee's own chosen password.
 */
export async function acceptInvite(token: string, password: string): Promise<{ id: string; name: string; email: string } | null> {
  const user = await resolveInviteToken(token);
  if (!user) return null;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(password),
      inviteToken: null,
      inviteTokenExpiresAt: null,
      inviteAcceptedAt: new Date(),
    },
  });
  return user;
}

export function inviteLinkFor(token: string): string {
  return `${env.corsOrigin}/accept-invite?token=${token}`;
}

export async function sendInviteEmail(user: { id: string; name: string; email: string }, token: string): Promise<ChannelSendResult> {
  const link = inviteLinkFor(token);
  return emailAdapter.send(
    {
      userId: user.id,
      name: user.name,
      email: user.email,
      phone: null,
      telegramChatId: null,
      slackMemberId: null,
      whatsappPhone: null,
      viberUserId: null,
      googleCalendarId: null,
      businessHoursOnly: false,
    },
    {
      subject: "Покана за TODF",
      body: `Здравей, ${user.name}!\n\nДобавен си в TODF. За да си зададеш парола и да влезеш в системата, отвори линка:\n${link}\n\nЛинкът е валиден 7 дни.`,
    }
  );
}
