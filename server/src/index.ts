import { createApp } from "./app";
import { startScheduler } from "./jobs/scheduler";
import { env } from "./lib/env";

const app = createApp();

app.listen(env.port, () => {
  console.log(`[server] listening on http://localhost:${env.port}`);
  startScheduler();
});
