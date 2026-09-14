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

// One-time startup diagnostic for a Prisma P2021 ("table does not exist")
// mystery in production: Pre-Deploy's `prisma migrate deploy` reports success
// on every deploy (even printing "database created", never "already exists"),
// yet the running server can't see the table it just created — implying the
// two steps aren't looking at the same disk. This dumps exactly what the
// running process sees at the DATABASE_URL path so that can be confirmed
// from the deploy logs, without needing shell access to the instance.
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

const app = createApp();

logDbDiskState();

app.listen(env.port, () => {
  console.log(`[server] listening on http://localhost:${env.port}`);
  startScheduler();
});
