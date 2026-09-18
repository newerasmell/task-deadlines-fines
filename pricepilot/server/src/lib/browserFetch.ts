import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Playwright's own per-call timeouts (goto, waitForLoadState) have been
// observed live to not always bound the actual wall-clock time — confirmed
// live on jeftinije.hr's crawl, a run just stopped producing any output for
// 2+ hours with no error, most likely a native JS dialog (cookie/age
// consent) blocking navigation that nothing was there to dismiss. This
// wraps a promise in an unconditional external timeout so a single stuck
// page can never hang the caller past the time it was told to wait,
// whatever the internal cause.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// Some sites (confirmed live: jeftinije.hr) run the Didomi consent-management
// SDK and only serve certain requests normally — pagination came back 403
// until a human clicked "Accept" on the cookie banner once in the same
// browser — once a real user consents, the sites treat the session as
// legitimate. Didomi's own documented global API can grant that consent
// with no UI interaction needed: harmless no-op on any page that doesn't
// use Didomi (window.Didomi is just undefined there).
// String (not a TS function) since this server's tsconfig has no DOM lib —
// the script itself still runs entirely in-browser, same pattern as the
// navigator.webdriver override in newContext() below.
const ACCEPT_DIDOMI_CONSENT_SCRIPT = `
  new Promise((resolve) => {
    if (window.Didomi) {
      try { window.Didomi.setUserAgreeToAll(); } catch (e) {}
      resolve();
      return;
    }
    window.didomiOnReady = window.didomiOnReady || [];
    window.didomiOnReady.push(() => {
      try { window.Didomi.setUserAgreeToAll(); } catch (e) {}
      resolve();
    });
    setTimeout(resolve, 3000);
  })
`;

async function acceptDidomiConsent(page: Page): Promise<void> {
  await page.evaluate(ACCEPT_DIDOMI_CONSENT_SCRIPT).catch(() => {
    // page navigated away / context closed mid-evaluate — not fatal
  });
  // Confirmed live: the banner can still be visibly on screen on some page
  // loads even after the API call above (Didomi not finishing init within
  // the 3s that call waits, most likely) — a direct click on the actual
  // "Prihvaćam i zatvori" button is the fallback for whenever that happens.
  await page
    .locator("button:has-text('Prihvaćam')")
    .first()
    .click({ timeout: 2000 })
    .catch(() => {
      // no banner on screen this time — normal, not an error
    });
}

// jeftinije.hr sits behind Cloudflare; some requests land on its
// "Just a moment..." interstitial instead of the real page. That page runs
// its own JS challenge and replaces itself automatically within a few
// seconds for a real browser that just lets it run — this only waits for
// that (the same patience an actual visitor has), with a hard timeout so a
// challenge that never clears can't hang the caller. Not an attempt to
// defeat or solve the challenge, just to wait it out.
async function waitOutCloudflareChallenge(page: Page, timeoutMs = 20000): Promise<boolean> {
  try {
    await page.waitForFunction("document.title !== 'Just a moment...'", null, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function loadPage(page: Page, url: string, timeoutMs: number, waitForSelector?: string): Promise<string> {
  let res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  if (res && !res.ok()) {
    const title = await page.title().catch(() => "");
    if (title === "Just a moment...") {
      const cleared = await waitOutCloudflareChallenge(page);
      if (!cleared) throw new Error(`HTTP ${res.status()} (Cloudflare challenge) fetching ${url}`);
      res = null; // challenge cleared itself; fall through to read the real content
    } else {
      throw new Error(`HTTP ${res.status()} fetching ${url}`);
    }
  }
  await acceptDidomiConsent(page);
  let contentConfirmed = false;
  if (waitForSelector) {
    // Confirmed live on notino.hr: page 2+ of a brand's listing (navigated
    // to directly by URL, not by clicking "next" in a real session) can
    // still be mid-render when networkidle below already looks quiet —
    // domcontentloaded fires before the SPA has fetched/rendered its
    // product grid, so reading page.content() a moment too early yields a
    // real 200 page with zero product cards and no pagination link, which
    // silently looks like "this is the last page" instead of the truth
    // ("we read it too soon"). Waiting for a selector the caller knows
    // marks real content is a much more direct signal than networkidle for
    // pages like this.
    contentConfirmed = await page
      .waitForSelector(waitForSelector, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
  }
  // Best-effort wait for any follow-up XHR/fetch-rendered content (a
  // search-results page commonly loads its listings this way) — NOT a hard
  // requirement: waitUntil: "networkidle" on goto() itself was tried and
  // confirmed live to time out entirely on real sites with persistent
  // background connections (analytics, ads) that never go fully idle,
  // failing the whole fetch even though the actual content had rendered
  // long before. Capped short and swallowed on timeout so a page that never
  // idles just falls through to whatever's already in the DOM instead of
  // failing the attempt. Skipped once waitForSelector already confirmed the
  // real content is there — confirmed live that stacking both waits back to
  // back on a heavy React app (notino.hr) held the page/its background
  // connections open long enough to be part of what got this server
  // OOM-killed on a 512MB instance; there's nothing left worth waiting for.
  if (!contentConfirmed) {
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  }
  return await page.content();
}

// Headless Chromium instead of a plain HTTP request for scrape sources: some
// competitor sites block non-browser clients outright via TLS/header
// fingerprinting that no amount of manually-set fetch() headers can fix —
// confirmed live against douglas.hr, whose server 400'd our plain request
// for a URL that loaded fine in a real browser. A real (headless) browser
// looks like an actual browser at the network level.
//
// Scoped to the lifetime of one refreshScrapeSource() run via BrowserSession
// below, not a persistent module-level singleton: Chromium alone can use
// 150-300MB+ RAM, real pressure on a small hosting plan. Better to pay the
// ~1-2s launch cost once per refresh and free the memory the moment that
// refresh finishes than hold a browser resident for the server's whole
// lifetime.
export class BrowserSession {
  private browserPromise: Promise<Browser> | null = null;

  private browser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = chromium.launch({
        headless: true,
        // --disable-blink-features=AutomationControlled removes the most
        // widely-checked-for Chromium automation flag; confirmed live that
        // douglas.hr specifically 403s a plain headless launch (as opposed
        // to the "Executable doesn't exist" infra error from before, which
        // this fix didn't touch) — this and the navigator.webdriver
        // override below in get() are the standard, honest fix for that:
        // just not announcing this is an automated browser, nothing beyond
        // that (no proxies, no CAPTCHA-solving).
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
        // Unset in production — Playwright resolves its own downloaded
        // browser there. Only used for local/sandbox dev environments where
        // the installed browser build doesn't match this playwright
        // version's expected default path.
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
      });
    }
    return this.browserPromise;
  }

  async newContext(): Promise<BrowserContext> {
    const browser = await this.browser();
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: "hr-HR",
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { "Accept-Language": "hr-HR,hr;q=0.9,en-US;q=0.8,en;q=0.7" },
    });
    // navigator.webdriver is `true` by default in every automated Chromium
    // session and is the single most common signal sites check for — flip
    // it back to how a real browser reports it, before any page script runs.
    // Passed as a string (not a TS function) since this server's tsconfig
    // has no DOM lib — the script itself still runs entirely in-browser.
    await context.addInitScript(
      "Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', { get: () => undefined });"
    );
    // Block images/fonts/media/stylesheets — we only ever read text and
    // structured data out of the page, never how it looks. Confirmed live
    // that the server started 502ing under real scrape load (this runs on a
    // 512MB instance; Chromium alone commonly uses 150-300MB, and a full
    // page load — images, web fonts, CSS — pushes both memory and time per
    // page well past what's actually needed here). Cuts both.
    //
    // Also block well-known analytics/ad/tag-manager hosts outright —
    // confirmed live that a modern React storefront (notino.hr) OOM-killed
    // this same 512MB instance on just its 2nd page, something jeftinije.hr's
    // much plainer markup never did even across a long multi-brand crawl.
    // These trackers run continuous background JS/XHR work that's pure
    // overhead for scraping text content, and (unlike a real visitor) we
    // have no use for any of it.
    const BLOCKED_HOSTS = [
      "google-analytics.com",
      "googletagmanager.com",
      "doubleclick.net",
      "facebook.net",
      "facebook.com",
      "connect.facebook.net",
      "hotjar.com",
      "clarity.ms",
      "segment.com",
      "segment.io",
      "criteo.com",
      "criteo.net",
      "adnxs.com",
      "bing.com",
      "tiktok.com",
    ];
    await context.route("**/*", (route) => {
      const request = route.request();
      const type = request.resourceType();
      if (type === "image" || type === "font" || type === "media" || type === "stylesheet") {
        return route.abort();
      }
      try {
        const host = new URL(request.url()).hostname;
        if (BLOCKED_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) {
          return route.abort();
        }
      } catch {
        // Malformed/unparseable URL — not our concern here, let it through.
      }
      return route.continue();
    });
    // Auto-dismiss any native dialog (cookie/age-consent confirm(), a
    // beforeunload prompt) the moment it appears — confirmed live that an
    // unhandled one can block navigation indefinitely, past even goto()'s
    // own timeout, since nothing here was answering it. Belt-and-braces
    // alongside the external withTimeout() wrapper below, not a substitute
    // for it — this only helps when the block IS a dialog.
    context.on("page", (page) => {
      page.on("dialog", (dialog) => {
        dialog.dismiss().catch(() => {});
      });
    });
    return context;
  }

  async get(url: string, timeoutMs = 30000): Promise<string> {
    const context = await this.newContext();
    try {
      const page = await context.newPage();
      return await withTimeout(loadPage(page, url, timeoutMs), timeoutMs + 10000, `get ${url}`);
    } finally {
      await context.close();
    }
  }

  // A fresh incognito context per single navigation (what get() above does)
  // means every request — including page 2 of the same listing a real
  // visitor just paginated into from page 1 — shows up as a brand-new,
  // cookie-less "first visit", which some sites use as a bot signal. A
  // PersistentPage keeps ONE context/page (and its cookies) alive across
  // every navigation the caller makes with it instead, so a multi-page
  // crawl looks like one continuous browsing session. Confirmed live on
  // jeftinije.hr: this is what an actual clean, complete crawl needed — a
  // fresh-context-per-request design was tried afterwards specifically to
  // bound a stuck page's blast radius (after a very first PersistentPage
  // attempt, before Cloudflare-challenge handling existed, hung for 2+
  // hours), but real runs favor the persistent session enough to go back
  // to it now that loadPage() waits out a Cloudflare challenge with its own
  // hard timeout and withTimeout() below bounds the whole call regardless.
  async newPersistentPage(): Promise<PersistentPage> {
    const context = await this.newContext();
    const page = await context.newPage();
    return new PersistentPage(this, context, page);
  }

  async close(): Promise<void> {
    if (!this.browserPromise) return;
    const browser = await this.browserPromise;
    this.browserPromise = null;
    await browser.close().catch(() => {
      // Best-effort — nothing meaningful to do if shutdown itself fails.
    });
  }
}

// Confirmed live: this server runs on a 512MB instance, and a single
// context/page held open across a long crawl (hundreds of navigations for
// the full brand list) grew memory enough to get the whole process
// OOM-killed and restarted by the platform mid-crawl — a genuinely
// continuous session works locally on a real machine with real RAM, but
// isn't free here. Recycling the context (fresh context + page, cookies
// carried over) every so often bounds that growth while keeping most of
// the same-session continuity within each stretch.
const RECYCLE_AFTER_NAVIGATIONS = 20;

export class PersistentPage {
  private navigationCount = 0;

  constructor(private session: BrowserSession, private context: BrowserContext, private page: Page) {}

  async goto(url: string, timeoutMs = 30000, waitForSelector?: string): Promise<string> {
    this.navigationCount++;
    if (this.navigationCount > 1 && this.navigationCount % RECYCLE_AFTER_NAVIGATIONS === 0) {
      await this.recycle();
    }
    return withTimeout(loadPage(this.page, url, timeoutMs, waitForSelector), timeoutMs + 10000, `get ${url}`);
  }

  private async recycle(): Promise<void> {
    const cookies = await this.context.cookies().catch(() => []);
    const oldContext = this.context;
    this.context = await this.session.newContext();
    if (cookies.length > 0) await this.context.addCookies(cookies).catch(() => {});
    this.page = await this.context.newPage();
    await oldContext.close().catch(() => {
      // Best-effort — nothing meaningful to do if the old context won't close.
    });
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
