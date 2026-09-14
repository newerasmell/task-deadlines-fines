import { NextFunction, Request, Response } from "express";

declare module "express-session" {
  interface SessionData {
    authenticated?: boolean;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.authenticated) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}
