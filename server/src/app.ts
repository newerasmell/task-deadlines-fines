import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { env } from "./lib/env";
import { auditLogRouter } from "./routes/auditLog";
import { authRouter } from "./routes/auth";
import { fineRulesRouter } from "./routes/fineRules";
import { finesRouter } from "./routes/fines";
import { leavesRouter, rescheduleRequestsRouter } from "./routes/leaves";
import { notificationsRouter } from "./routes/notifications";
import { projectsRouter } from "./routes/projects";
import { taskTemplatesRouter } from "./routes/taskTemplates";
import { tasksRouter } from "./routes/tasks";
import { usersRouter } from "./routes/users";

export function createApp() {
  const app = express();

  app.use(cors({ origin: env.corsOrigin }));
  app.use(express.json());

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/tasks", tasksRouter);
  app.use("/api/projects", projectsRouter);
  app.use("/api/task-templates", taskTemplatesRouter);
  app.use("/api/fines", finesRouter);
  app.use("/api/fine-rules", fineRulesRouter);
  app.use("/api/leaves", leavesRouter);
  app.use("/api/reschedule-requests", rescheduleRequestsRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/audit-log", auditLogRouter);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
