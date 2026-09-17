import cron from "node-cron";
import { prisma } from "../lib/prisma";
import { syncCatalog } from "../services/catalogSync";
import { refreshSource } from "../services/competitorCollection";

// Per-source refresh interval defaults to 24h (per the brief) — tracked
// here as "has it been >= 24h since lastRefreshedAt", checked on a 15-min
// tick, rather than scheduling one cron job per source (simpler to reason
// about, and trivially copes with sources added/removed at runtime).
const SOURCE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function tickSourceRefresh() {
  const sources = await prisma.source.findMany({ where: { active: true, autoRefresh: true } });
  const now = Date.now();
  for (const source of sources) {
    const due = !source.lastRefreshedAt || now - source.lastRefreshedAt.getTime() >= SOURCE_REFRESH_INTERVAL_MS;
    if (!due) continue;
    try {
      await refreshSource(source.id);
    } catch (err) {
      console.error(`[scheduler] source refresh failed for ${source.id}`, err);
    }
  }
}

async function nightlyCatalogSync() {
  const stores = await prisma.store.findMany();
  for (const store of stores) {
    try {
      await syncCatalog(store.id);
    } catch (err) {
      console.error(`[scheduler] catalog sync failed for store ${store.id}`, err);
    }
  }
}

export function startScheduler() {
  // Checks every 15 minutes whether any source's 24h window has elapsed.
  cron.schedule("*/15 * * * *", () => {
    tickSourceRefresh().catch((err) => console.error("[scheduler] source refresh tick failed", err));
  });

  // Nightly catalog sync at 03:00 server time.
  cron.schedule("0 3 * * *", () => {
    nightlyCatalogSync().catch((err) => console.error("[scheduler] nightly catalog sync failed", err));
  });

  console.log("[scheduler] started (source refresh every 15m check, catalog sync nightly at 03:00)");
}
