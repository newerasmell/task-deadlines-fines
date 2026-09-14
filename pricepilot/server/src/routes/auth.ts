import { Router } from "express";
import { z } from "zod";
import { env } from "../lib/env";

export const authRouter = Router();

const loginSchema = z.object({ password: z.string().min(1) });

authRouter.post("/login", (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Password required" });

  if (parsed.data.password !== env.dashboardPassword) {
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
