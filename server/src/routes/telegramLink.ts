import { Router } from "express";
import { env } from "../lib/env";
import { createLinkToken, resolveAndConsumeLinkToken } from "../lib/telegramLink";
import { requireAuth } from "../middleware/auth";

export const telegramLinkRouter = Router();

// Self-service: the logged-in employee's Profile page calls this to get a
// one-time deep link, opens it, and the bot's webhook (below) does the
// rest once they tap "Start" in Telegram — no admin involved.
telegramLinkRouter.post("/token", requireAuth, async (req, res) => {
  if (!env.telegramBotUsername) {
    return res.status(400).json({ error: "TELEGRAM_BOT_USERNAME не е конфигуриран на сървъра." });
  }
  const token = await createLinkToken(req.user!.sub);
  res.json({
    token,
    botUsername: env.telegramBotUsername,
    deepLink: `https://t.me/${env.telegramBotUsername}?start=${token}`,
  });
});

interface TelegramUpdate {
  message?: {
    chat?: { id?: number | string };
    text?: string;
  };
}

async function sendTelegramMessage(chatId: string | number, text: string): Promise<void> {
  if (!env.telegramBotToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error("[telegram-link] failed to send confirmation message:", err);
  }
}

// Telegram calls THIS (not the other way around) — the browser never hits
// this route. The unguessable :secret path segment stands in for the auth
// a logged-in user's request would normally carry, since Telegram's own
// webhook requests obviously carry no JWT of ours. Always replies 200 —
// Telegram retries a webhook that doesn't — even when the token turns out
// to be invalid/expired, so the one real failure case (an employee waited
// too long) still gets a reply in the chat instead of silence.
telegramLinkRouter.post("/webhook/:secret", async (req, res) => {
  if (!env.telegramWebhookSecret || req.params.secret !== env.telegramWebhookSecret) {
    return res.status(404).end();
  }
  res.status(200).end();

  const update = req.body as TelegramUpdate;
  const chatId = update.message?.chat?.id;
  const text = update.message?.text;
  if (chatId == null || !text?.startsWith("/start ")) return;

  const token = text.slice("/start ".length).trim();
  if (!token) return;

  const user = await resolveAndConsumeLinkToken(token, String(chatId));
  if (!user) {
    await sendTelegramMessage(chatId, "Кодът е невалиден или е изтекъл — върни се в своя профил в TODF и натисни пак „Свържи Telegram“.");
    return;
  }
  await sendTelegramMessage(chatId, `Успешно свързан с TODF, ${user.name}! Оттук нататък ще получаваш известията тук.`);
});
