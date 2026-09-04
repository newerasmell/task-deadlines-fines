import { env } from "./env";

// Notification text is composed on the server, which on Render runs in UTC —
// unlike the browser (which formats dates in the viewer's own timezone), so
// without an explicit timeZone here every notification showed deadlines
// hours off from what the app itself displays. Pin it to the team's zone.
export function formatDateTime(date: Date): string {
  return date.toLocaleString("bg-BG", { timeZone: env.timezone });
}

// For a value that represents a calendar day rather than a real instant
// (a Leave's start/end — see leaves.ts) — pinned to UTC, since that's how
// the day was anchored when parsed from a plain "YYYY-MM-DD" input, not to
// env.timezone: formatting a day-boundary instant (e.g. 23:59:59.999Z) in
// the team's local zone can roll it into the next calendar day for anyone
// east of UTC.
export function formatDateOnly(date: Date): string {
  return date.toLocaleDateString("bg-BG", { timeZone: "UTC" });
}
