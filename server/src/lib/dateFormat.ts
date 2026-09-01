import { env } from "./env";

// Notification text is composed on the server, which on Render runs in UTC —
// unlike the browser (which formats dates in the viewer's own timezone), so
// without an explicit timeZone here every notification showed deadlines
// hours off from what the app itself displays. Pin it to the team's zone.
export function formatDateTime(date: Date): string {
  return date.toLocaleString("bg-BG", { timeZone: env.timezone });
}
