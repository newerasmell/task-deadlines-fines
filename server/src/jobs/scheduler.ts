import cron from "node-cron";
import { env } from "../lib/env";
import { runDeadlineScan } from "./deadlineScanner";
import { runGoogleMeetSync } from "./googleMeetSync";
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

  // Only scheduled when all three Google credentials are present — without
  // them every tick would just log the same "not configured" error, and the
  // admin already sees that same state on the Meet settings panel instead.
  if (env.googleClientId && env.googleClientSecret && env.googleRefreshToken) {
    cron.schedule(env.googleMeetPollCron, () => {
      runGoogleMeetSync().catch((err) => {
        console.error("[scheduler] Google Meet sync failed:", err);
      });
    });
    console.log(`[scheduler] Google Meet sync started with cron "${env.googleMeetPollCron}"`);
  }
}
