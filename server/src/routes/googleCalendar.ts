import { Router } from "express";
import { env } from "../lib/env";
import {
  buildAuthUrl,
  connectUserAccount,
  disconnectUserAccount,
  isGoogleCalendarConfigured,
  verifyOAuthState,
} from "../lib/googleCalendarOAuth";
import { prisma } from "../lib/prisma";
import { requireAuth } from "../middleware/auth";

export const googleCalendarRouter = Router();

// Whether "Push to Calendar" is connected for the CURRENT user (not the
// admin-level shared calendar) — the frontend uses this to enable/disable
// the push button and show connect/disconnect state.
googleCalendarRouter.get("/status", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.sub },
    select: { googleConnectedAt: true },
  });
  res.json({
    configured: isGoogleCalendarConfigured(),
    connected: Boolean(user?.googleConnectedAt),
    connectedAt: user?.googleConnectedAt ?? null,
  });
});

// Returns the Google consent URL rather than redirecting directly — this is
// called via the SPA's normal authenticated fetch() (api()), which can't
// itself follow a cross-origin redirect into Google's own login/consent
// pages; the frontend does `window.location.href = url` with what comes
// back instead.
googleCalendarRouter.get("/oauth/start", requireAuth, async (req, res) => {
  if (!isGoogleCalendarConfigured()) {
    return res.status(400).json({ error: "Google Calendar не е конфигуриран на сървъра." });
  }
  res.json({ url: buildAuthUrl(req.user!.sub) });
});

// Google redirects the actual BROWSER here after consent — a top-level
// navigation, not a fetch, so there's no Authorization header to check
// (requireAuth doesn't apply); `state` (see signOAuthState) is what
// identifies the user instead. Always ends in a redirect back to the SPA,
// success or failure, since a JSON response here would just show as a raw
// API response in the browser with nothing the user can do about it.
googleCalendarRouter.get("/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  const returnTo = `${env.corsOrigin}/profile`;

  if (!code || !state) {
    return res.redirect(`${returnTo}?google=error`);
  }
  try {
    const userId = verifyOAuthState(state);
    await connectUserAccount(userId, code);
    res.redirect(`${returnTo}?google=connected`);
  } catch (err) {
    console.error("[google-calendar] OAuth callback failed:", err);
    res.redirect(`${returnTo}?google=error`);
  }
});

googleCalendarRouter.delete("/disconnect", requireAuth, async (req, res) => {
  await disconnectUserAccount(req.user!.sub);
  res.json({ ok: true });
});
