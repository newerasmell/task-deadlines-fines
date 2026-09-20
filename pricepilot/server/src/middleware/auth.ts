import { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";

declare module "express-session" {
  interface SessionData {
    userId?: string;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // Set by requireAuth once the session's userId is confirmed to still
      // belong to an active user — routes that write to the audit log read
      // this rather than trusting the raw session value.
      userId?: string;
      isUltimateAdmin?: boolean;
    }
  }
}

// Re-checks the user is still active on every request (not just at login
// time) so deactivating someone (Settings -> Team) ends their access
// immediately, not just blocks a future login.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const userId = req.session.userId;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.active) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: "Not authenticated" });
  }

  req.userId = user.id;
  req.isUltimateAdmin = user.isUltimateAdmin;
  next();
}

// Must run after requireAuth. Gates account management (see/create/edit/
// deactivate/delete OTHER users) to ultimate admins — everyone else only
// gets self-service via PATCH /auth/me.
export function requireUltimateAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.isUltimateAdmin) return res.status(403).json({ error: "Ultimate admin only" });
  next();
}
