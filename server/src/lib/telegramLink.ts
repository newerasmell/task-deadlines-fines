import { randomBytes } from "crypto";
import { prisma } from "./prisma";

// How long a "Свържи Telegram" deep link stays valid before the employee
// has to re-click the button on their own Profile page for a fresh one.
const LINK_TOKEN_TTL_MS = 15 * 60 * 1000;

// Telegram's own `/start <payload>` deep-link parameter only allows
// [A-Za-z0-9_-], up to 64 bytes — a JWT's "." separators (the pattern
// googleCalendarOAuth.ts uses for its own short-lived state token) don't
// fit that charset, so this is a plain random opaque string stored on the
// row instead, not a signed token.
export function generateLinkToken(): string {
  return randomBytes(16).toString("hex");
}

export async function createLinkToken(userId: string): Promise<string> {
  const token = generateLinkToken();
  await prisma.user.update({
    where: { id: userId },
    data: { telegramLinkToken: token, telegramLinkTokenExpiresAt: new Date(Date.now() + LINK_TOKEN_TTL_MS) },
  });
  return token;
}

/**
 * Resolves a `/start <token>` deep-link token back to the employee who
 * generated it, and completes the link — called from the Telegram
 * webhook once a message arrives. Returns null for an unknown or expired
 * token (the caller sends the employee a "try again from your profile"
 * reply in that case) rather than throwing, since an expired click is an
 * ordinary, expected outcome, not a server error.
 *
 * Before stamping telegramChatId onto the resolved user, this clears that
 * same chatId off any OTHER user row that still has it — otherwise
 * re-linking a shared/reused Telegram account to a new TODF user could
 * leave two accounts both looking "connected" to the same chat, and
 * notifications meant for one person would also reach the other.
 */
export async function resolveAndConsumeLinkToken(token: string, chatId: string): Promise<{ id: string; name: string } | null> {
  const user = await prisma.user.findFirst({
    where: { telegramLinkToken: token, telegramLinkTokenExpiresAt: { gt: new Date() } },
    select: { id: true, name: true },
  });
  if (!user) return null;

  await prisma.user.updateMany({
    where: { telegramChatId: chatId, NOT: { id: user.id } },
    data: { telegramChatId: null },
  });
  await prisma.user.update({
    where: { id: user.id },
    data: { telegramChatId: chatId, telegramLinkToken: null, telegramLinkTokenExpiresAt: null },
  });

  return user;
}
