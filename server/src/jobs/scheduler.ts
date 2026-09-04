import cron from "node-cron";
import { env } from "../lib/env";
import { runDeadlineScan } from "./deadlineScanner";
import { runSubscriptionScan } from "./subscriptionScanner";

export function startScheduler(): void {
  cron.schedule(env.schedulerCron, () => {
    runDeadlineScan().catch((err) => {
      console.error("[scheduler] deadline scan failed:", err);
    });
    runSubscriptionScan().catch((err) => {
      console.error("[scheduler] subscription scan failed:", err);
    });
  });
  console.log(`[scheduler] started with cron "${env.schedulerCron}"`);
}
