# PricePilot

Shopify competitive pricing dashboard. Connects to a Shopify store's Admin
API, pulls the catalog, fetches competitor prices from up to 3 configured
sources, computes a suggested price per product, and lets you publish new
prices back to Shopify — one at a time or in bulk.

This is a **separate application** from the TODF task/fine system this repo
also hosts — its own server, its own SQLite database, its own login (per-user
accounts, not TODF accounts — see Accounts & audit log below). It's here
because that's where the git history lives, not because the two apps share
anything. An admin-only "PricePilot ↗" link appears in the TODF sidebar once
you set `VITE_PRICEPILOT_URL` in `web/.env` (see the root `web/.env.example`).

## Architecture

- `server/` — Node + Express + TypeScript, Prisma/SQLite, node-cron running
  in-process (no separate worker). Serves the REST API under `/api` and,
  in production, the built React app for everything else.
- `web/` — React + Vite + TypeScript.
- One Web Service on Render; SQLite lives on a persistent disk.

## Local development

```bash
cd pricepilot/server
cp .env.example .env
# generate a real key: openssl rand -hex 32
# edit .env: set DASHBOARD_PASSWORD, SESSION_SECRET, ENCRYPTION_KEY
npm install
npx prisma migrate dev
npm run dev            # http://localhost:4100

cd ../web
cp .env.example .env   # VITE_API_URL=http://localhost:4100/api
npm install
npm run dev             # http://localhost:5174
```

First run: the login page shows a one-time "create the first account" form —
your name/email/a real password, plus `DASHBOARD_PASSWORD` to prove you're
allowed to set it up. Every teammate after that gets added from inside the
app (Settings → Team), no shared password involved. See Accounts & audit log
below. Add a store under Settings, paste the Shopify app's Client ID and
Client secret (below), "Test connection", then "Sync now".

## Creating a Shopify app for a store

Shopify retired the old admin-side "Develop apps" flow (the one that handed
you a static `shpat_…` Admin API access token directly) for new apps. Every
new custom app now goes through the **Dev Dashboard** instead, and
authenticates via the OAuth **client_credentials** grant — PricePilot
exchanges the Client ID/secret for a short-lived (~24h) Admin API token
itself, automatically, and re-exchanges before it expires
(`src/services/shopifyClient.ts`), so the fields you enter are permanent
even though the token behind them isn't.

1. Go to **dev.shopify.com/dashboard** (a different site from your store's
   own admin) and create an app, or open an existing one.
2. Under **Configuration** (or during app creation) → **API access** →
   **Scopes**, add:
   - `read_products`
   - `write_products`
3. Save/continue through the app's setup (App URL can be anything valid —
   `https://` + your PricePilot URL works fine, it's never actually called
   for this integration) until the app is created.
4. **Install the app on your store**: from the store's own admin, go to
   **Settings → Apps and sales channels**, find the app in the installed
   list (it should already be there if you created/configured it for this
   store), and confirm the scopes shown match what you set above.
5. Back in the Dev Dashboard, open the app → **Settings** → **Credentials**.
   Copy the **Client ID** and **Secret** (`shpss_…`) shown there — this is
   the pair PricePilot needs, entered as **Client ID** and **Client secret**
   when adding the store in Settings.

Do **not** use the **App automation token** (`atkn_…`) section on that same
page — that's for authenticating the Shopify CLI in CI/CD pipelines
(`shopify app deploy`), not for Admin API calls, and won't work here.

## Pricing rule fields

- **Strategy**: `undercut_min` (beat the lowest competitor price by
  `undercutPct`%), `match_min` (match it exactly), or `undercut_avg` (beat
  the *average* competitor price by `undercutPct`%).
- **Price ending**: optional, e.g. `.99` — the suggestion is always rounded
  *down* to the nearest value with that ending, never up.
- **Margin floor**: the suggestion never goes below `cost × (1 +
  minMarginPct%)`. If no cost is on file for a product (see costs import
  below), the floor falls back to `current price × NO_COST_FLOOR_PCT` (env
  var, default 0.7). A row that would have gone below floor is flagged
  amber and shows the floor value instead.

## Sources

Up to 4 per store.

- **`shopify_json`** — the competitor runs Shopify too: paginates their
  public `/products.json` endpoint (no auth needed, no admin token). Fast,
  matches near-100% on EAN. Prefer this whenever the competitor qualifies.
- **`scrape`** — anything else: for each of *our* products, requests a
  templated search URL (`{EAN}`, or `{QUERY}` = brand+name if no barcode)
  via a real headless Chromium (plain HTTP requests get blocked outright by
  some sites' bot detection). Only structured, site-authored price signals
  are trusted (JSON-LD → meta tags) — no plain-text currency scan, since
  that produced false-positive prices on pages with no actual match.
  A search-results page usually lists several sibling products (different
  scent lines, sizes); the closest title match is picked (not just the
  first JSON-LD block on the page) and its own product page is visited to
  read the exact size/price variant, rather than trusting the listing's
  default price. A confirmed "not found" only clears a previously-matched
  price after two consecutive not-found results, to absorb one-off page
  load hiccups. Polite by design: ~1 request per 2-3s, a real User-Agent,
  30s timeout, no proxies, no CAPTCHA bypass — a source that keeps failing
  gets flagged `degraded` in Settings rather than retried harder. Every
  `scrape` product is anchored to a specific one of our products from the
  start (we searched *for* it), so there's no ambiguous matching step for
  this source type — only `shopify_json` listings ever land in the
  Unmatched tab.
- **`manual_import`** — for sites that block automated fetching outright
  (bot detection a headless browser can't get past): instead of a live
  fetch, Settings offers a "Download template" CSV (every product, its
  SKU/vendor/title/size, plus a pre-built search URL per the source's
  template if one's set) and an "Upload results" file input. A person or a
  Cowork agent searches the site by hand, fills in `competitor_price` (or
  `not_found`) per row on that same file, and re-uploads it — rows are
  matched by `product_id`, so there's no fuzzy matching or title-guessing
  on the way back in. Writes through the exact same price/not-found
  recording logic (hysteresis included) as `scrape`. Never runs on its own
  — the scheduler and "Refresh now" no-op for this type.
- **Scrape prioritization**: products flagged priority (manually, or the
  top 20 by `price × inventoryQuantity`) get scraped every run; everything
  else rotates through roughly one-seventh of the remaining catalog per
  run (a stable hash bucket, not stored state) — so the full catalog cycles
  over about a week rather than every product being scraped every day.
  (`manual_import` templates always list the full catalog — there's no
  automated request budget to ration there.)

## Matching (shopify_json sources only)

1. Exact EAN/barcode match.
2. Fallback: normalized `brand + name` text with the `ml` token pulled out
   and required to match exactly (`src/lib/textNormalize.ts`).
3. A manual binding in the Unmatched tab always overrides both, permanently
   (until removed), for that source+product pair.

## Costs import

Settings → Import costs — CSV with two columns, `sku_or_ean,cost` (header
row optional). Feeds the margin floor guard above.

## Accounts & audit log

Per-user login (name, email, password — bcrypt-hashed), not the old single
shared password. `DASHBOARD_PASSWORD` still exists but now only gates the
one-time "create the first account" form shown on `/login` while the `User`
table is empty; every account after that is added from Settings → Team by
anyone already logged in. There's no role hierarchy — every account can see
and change everything, same trust level the old shared password implied.

A deactivated account is logged out immediately (`requireAuth` re-checks
`active` on every request, not just at login) and can be reactivated later;
deleting one keeps its past Audit log rows (shown with actor "deleted user").
The last active account can't be deactivated or deleted, and nobody can
deactivate/delete themselves — both guard against locking everyone out.

Every store/source/cost/COD-formula/publish change writes one row to
`AuditLog` (`lib/audit.ts`) with who did it — visible under the "Audit log"
nav item, filterable by action or free-text search over the summary.
Read-only actions (viewing a page, a scheduled competitor-price refresh)
aren't logged; this tracks human decisions, not requests.

## Catalog sync

Cursor pagination by default; switches to Shopify's Bulk Operations API
(submit → poll → download JSONL) once a store's product count crosses
`BULK_THRESHOLD_PRODUCT_COUNT` (250, in `catalogSync.ts`) — a proxy for the
brief's "~1,000 variants" threshold, since counting variants directly costs
an extra round trip; tune it if a store's variants-per-product ratio is
unusual. Manual "Sync now" in Settings, plus a nightly 03:00 cron.

## Deploying to Render

This repo has two apps in it, so `render.yaml` lives at
`pricepilot/render.yaml`, not the repo root.

**Simplest: create the Web Service manually** (no Blueprint needed for one
service) — New → Web Service, point at this repo, then:

- **Root Directory**: `pricepilot`
- **Build Command** (the `--include=dev` flags matter: `NODE_ENV=production`
  below is visible during the build too, and npm skips devDependencies
  under it by default — which is where typescript/@types/prisma/vite live.
  `PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install --force chromium
  chromium-headless-shell` downloads the browser binaries the scrape-source
  refresh needs at runtime — both browser names are required:
  `chromium.launch({headless:true})` resolves to the separate "headless
  shell" build, not the regular Chromium download. `PLAYWRIGHT_BROWSERS_PATH=0`
  matters a lot: confirmed live that Render's build and runtime don't share
  the default cache directory (`~/.cache/ms-playwright`) — the build log
  showed both browsers downloading successfully to 100%, yet the running
  server still couldn't find them. Setting this to `0` installs into
  `node_modules/playwright-core/.local-browsers` instead, which — unlike an
  external cache dir — is guaranteed to carry over into the running
  container since it's part of the deployed app; **it must also be set as a
  runtime env var** (see below), since install-time and launch-time both
  need to resolve the same path. `prisma migrate deploy` is deliberately
  *not* run in Build Command: persistent disks aren't mounted during the
  build step, only at runtime — the server runs its own migration at
  startup instead, in `index.ts`, before it starts listening):
  `cd server && npm install --include=dev && PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install --force chromium chromium-headless-shell && npx prisma generate && npm run build && cd ../web && npm install --include=dev && npm run build`
- **Start Command**: `cd server && npm start`
- Add a **persistent disk** mounted at `/data` (Settings → Disks — requires
  a paid plan, not Free)
- Env vars: `DASHBOARD_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_KEY`
  (`openssl rand -hex 32`), `DATABASE_URL=file:/data/pricepilot.db`,
  `NODE_ENV=production`, `PLAYWRIGHT_BROWSERS_PATH=0` (see above — required,
  not optional, for scrape sources to work). `NO_COST_FLOOR_PCT` and
  `SHOPIFY_API_VERSION` are optional (sane defaults in code).

**Or via Blueprint**: New → Blueprint, and when connecting the repo specify
the blueprint file path as `pricepilot/render.yaml` rather than accepting
the repo-root default.

Once deployed, set `VITE_PRICEPILOT_URL` to the service's URL in the root
`web/.env` (or on the TODF frontend's Render service) and redeploy TODF to
show the sidebar link.

## Known limitations (pilot scope)

- Session store is in-memory (`express-session` MemoryStore) — fine for a
  single Render instance per the brief's single-process design, but a
  restart logs everyone out and it isn't horizontally scalable. Swap in a
  SQLite-backed session store first if that becomes a problem.
- The generic HTML price parser (JSON-LD → meta tags → text scan) has no
  per-site CSS selectors, per the brief's non-goals — it'll miss prices on
  sites that expose neither structured data nor a plain currency string
  near the top of the page. A source doing this repeatedly shows as
  `degraded` rather than silently returning nothing.
- No currency conversion, no automatic/unattended publishing, no stock
  tracking, no multi-user roles — all explicitly out of scope for the
  pilot per the brief.
- `scrape` sources fetch pages with a real headless Chromium (via
  Playwright), not a plain HTTP request — some competitor sites block
  non-browser clients outright via TLS/header fingerprinting, which no
  amount of manually-set fetch() headers can get around. This has real
  costs: a browser instance uses meaningfully more memory than a plain
  request (launched per refresh run and closed immediately after, not
  kept resident, specifically to limit this) and is slower per product.
  On a small hosting plan this can hit memory limits under load — if
  refreshes start failing/crashing, the fix is a larger plan, not more
  code. It also still won't get past sites running dedicated bot-management
  services (Cloudflare, Akamai, DataDome, etc.) that specifically detect
  automated browsers — going further than that (stealth plugins, proxies,
  CAPTCHA-solving) is deliberately out of scope.

## Acceptance checklist

Everything below has been verified against the running app except the
items marked ⚠️, which need real Shopify/competitor network access this
sandboxed dev environment can't reach — the code paths involved are the
same ones exercised end-to-end with locally-seeded data (see the pricing
engine test output in the PR/commit description).

1. ⚠️ Add a store + token in Settings → "Test connection" passes → "Sync
   now" pulls the full catalog. *(Store/token CRUD, encryption, and the
   connection-test error path are verified; a live Shopify store is needed
   to see a successful connection.)*
2. Add a `shopify_json` source → refresh → prices appear with match rate
   visible; unmatched products listed in Unmatched tab. ✓ (matching logic
   and the Unmatched/manual-bind flow verified with seeded data)
3. ⚠️ Add a `scrape` source with a search template → priority products get
   prices. *(Parser, rate-limiting, and priority/rotation selection logic
   verified directly; needs a real competitor site to fetch from.)*
4. Suggestions respect strategy + floor; below-floor rows flagged amber. ✓
5. ⚠️ Single publish updates price (and compare-at when toggled) in Shopify
   and logs it. *(Publish flow, batching, compare-at toggle, and
   publish_log writes — including the error path — verified end-to-end;
   the actual Shopify write needs a live store.)*
6. ⚠️ Bulk publish of 50+ selected variants completes with per-row statuses
   and no rate-limit failures. *(Grouping/chunking to 100/call and the
   THROTTLED backoff formula are implemented per Shopify's docs; needs a
   real catalog that size to confirm the rate-limit math holds up live.)*
7. Adding a second store requires zero code changes. ✓ (every store/source
   is config rows in the database, nothing hardcoded)
