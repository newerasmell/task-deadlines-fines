import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { createApp } from "./app";
import { startScheduler } from "./jobs/scheduler";
import { env } from "./lib/env";

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

// Run migrations in THIS long-lived process rather than relying solely on
// Render's Pre-Deploy Command. Confirmed via the startup diagnostic below:
// Pre-Deploy's `prisma migrate deploy` reports success on every deploy (even
// printing "database created", never "already exists"), yet the running
// server finds a 0-byte db file at the same path a few seconds later. That's
// consistent with the short-lived Pre-Deploy job's writes never getting
// durably flushed to the persistent disk before its container exits — so
// migrating from inside the process that keeps the disk mounted for the
// service's whole lifetime sidesteps that entirely. Exits loudly on failure
// rather than serving traffic against a database that isn't there.
function runMigrations() {
  try {
    console.log("[startup] running prisma migrate deploy…");
    execSync("npx prisma migrate deploy", { stdio: "inherit" });
    console.log("[startup] migrations applied");
  } catch (err) {
    console.error("[startup] prisma migrate deploy failed:", err);
    process.exit(1);
  }
}

// Diagnostic left in place: confirms, from inside the running process, what
// it actually sees on disk after the migration above.
function logDbDiskState() {
  const match = (process.env.DATABASE_URL ?? "").match(/^file:(.+)$/);
  if (!match) return;
  const dbPath = path.resolve(process.cwd(), match[1]);
  const dir = path.dirname(dbPath);
  try {
    console.log(`[startup] DATABASE_URL resolves to ${dbPath}`);
    console.log(`[startup] dir listing of ${dir}:`, fs.existsSync(dir) ? fs.readdirSync(dir) : "(missing)");
    if (fs.existsSync(dbPath)) {
      const stat = fs.statSync(dbPath);
      console.log(`[startup] db file: size=${stat.size} bytes, mtime=${stat.mtime.toISOString()}`);
    } else {
      console.log("[startup] db file does not exist at that path");
    }
    console.log("[startup] df -h for that mount:\n" + execSync(`df -h "${dir}"`).toString());
  } catch (err) {
    console.error("[startup] disk diagnostic failed:", err);
  }
}

runMigrations();
logDbDiskState();

const app = createApp();

app.listen(env.port, () => {
  console.log(`[server] listening on http://localhost:${env.port}`);
  startScheduler();
});
