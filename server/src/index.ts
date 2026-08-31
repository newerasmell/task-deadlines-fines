import { createApp } from "./app";
import { startScheduler } from "./jobs/scheduler";
import { env } from "./lib/env";

// A bug in any single request handler (e.g. an unexpected Prisma validation
// error) must never take the whole server down for every other user — log
// it loudly and keep serving, instead of letting Node's default behavior
// crash the process on an unhandled rejection.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

const app = createApp();

app.listen(env.port, () => {
  console.log(`[server] listening on http://localhost:${env.port}`);
  startScheduler();
});
