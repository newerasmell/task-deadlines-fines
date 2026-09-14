import { Router } from "express";
import { z } from "zod";
import { env } from "../lib/env";

export const authRouter = Router();

const loginSchema = z.object({ password: z.string().min(1) });

authRouter.post("/login", (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Password required" });

  // Trimmed on both sides: a trailing newline/space is an easy, invisible
  // thing to pick up when a password is copy-pasted into an env var UI or a
  // browser field, and there's no legitimate reason a real password would
  // depend on leading/trailing whitespace.
  const given = parsed.data.password.trim();
  const expected = env.dashboardPassword.trim();
  if (given !== expected) {
    // Lengths only — never logs the actual values — so a mismatch caused by
    // stray whitespace (different length) is visible in Render's logs
    // without exposing either password.
    console.error(`[auth] login mismatch: submitted ${given.length} chars, expected ${expected.length} chars`);
    return res.status(401).json({ error: "Wrong password" });
  }
  req.session.authenticated = true;
  res.json({ ok: true });
});

authRouter.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

authRouter.get("/me", (req, res) => {
  res.json({ authenticated: Boolean(req.session.authenticated) });
});
