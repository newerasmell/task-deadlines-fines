import { createApp } from "./app";
import { startScheduler } from "./jobs/scheduler";
import { env } from "./lib/env";

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
