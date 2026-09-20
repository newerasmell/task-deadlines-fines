// Must be imported before any router: patches Express 4's routing so a
// thrown/rejected error from an `async` route handler reaches the error
// middleware below via next(err), instead of hanging the request forever
// with no response (Express 4 doesn't do this on its own — Express 5 does).
import "express-async-errors";
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import session from "express-session";
import path from "path";
import { env } from "./lib/env";
import { requireAuth, requireUltimateAdmin } from "./middleware/auth";
import { auditLogRouter } from "./routes/auditLog";
import { authRouter } from "./routes/auth";
import { codConfigRouter } from "./routes/codConfig";
import { costsRouter } from "./routes/costs";
import { pricingRouter } from "./routes/pricing";
import { publishRouter } from "./routes/publish";
import { publishLogRouter } from "./routes/publishLog";
import { sourcesRouter } from "./routes/sources";
import { storesRouter } from "./routes/stores";
import { unmatchedRouter } from "./routes/unmatched";
import { usersRouter } from "./routes/users";

const WEB_DIST = path.resolve(__dirname, "../../web/dist");

export function createApp() {
  const app = express();

  app.set("trust proxy", 1);
  app.use(cors({ origin: env.corsOrigin, credentials: true }));
  app.use(express.json({ limit: "5mb" }));
  app.use(
    session({
      name: "pp.sid",
      secret: env.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: env.isProduction,
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      },
    })
  );

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/auth", authRouter);

  // Everything else under /api requires a logged-in session.
  app.use("/api/stores", requireAuth, storesRouter);
  app.use("/api/sources", requireAuth, sourcesRouter);
  app.use("/api/pricing", requireAuth, pricingRouter);
  app.use("/api/publish", requireAuth, publishRouter);
  app.use("/api/publish-log", requireAuth, publishLogRouter);
  app.use("/api/unmatched", requireAuth, unmatchedRouter);
  app.use("/api/costs", requireAuth, costsRouter);
  app.use("/api/cod-config", requireAuth, codConfigRouter);
  app.use("/api/users", requireAuth, requireUltimateAdmin, usersRouter);
  app.use("/api/audit-log", requireAuth, auditLogRouter);

  // Serve the built React app (same Web Service, per the brief) and fall
  // back to index.html for any non-API route so client-side routing works.
  app.use(express.static(WEB_DIST));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIST, "index.html"));
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
