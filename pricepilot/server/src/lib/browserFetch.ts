import { chromium, type Browser, type BrowserContext, type Cookie, type Page } from "playwright";

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
}

async function loadPage(page: Page, url: string, timeoutMs: number): Promise<string> {
  const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  if (res && !res.ok()) {
    throw new Error(`HTTP ${res.status()} fetching ${url}`);
  }
  await acceptDidomiConsent(page);
  // Best-effort wait for any follow-up XHR/fetch-rendered content (a
  // search-results page commonly loads its listings this way) — NOT a hard
  // requirement: waitUntil: "networkidle" on goto() itself was tried and
  // confirmed live to time out entirely on real sites with persistent
  // background connections (analytics, ads) that never go fully idle,
  // failing the whole fetch even though the actual content had rendered
  // long before. Capped short and swallowed on timeout so a page that never
  // idles just falls through to whatever's already in the DOM instead of
  // failing the attempt.
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
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

  private async newContext(): Promise<BrowserContext> {
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
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "font" || type === "media" || type === "stylesheet") {
        return route.abort();
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
  // cookie-less "first visit", which some sites use as a bot signal.
  // getWithCookies() carries a caller-held cookie jar forward across
  // otherwise-separate get() calls (seeding each fresh context with the
  // cookies the previous one collected) — real session continuity without
  // keeping any single page/context alive across the whole crawl. A
  // PersistentPage approach (one page reused for hundreds of navigations)
  // was tried first and confirmed live to risk exactly the indefinite hang
  // withTimeout() above now guards against — a fresh, disposable context
  // per request bounds each request's blast radius to just that request.
  async getWithCookies(
    url: string,
    cookies: Cookie[],
    timeoutMs = 30000
  ): Promise<{ html: string; cookies: Cookie[] }> {
    const context = await this.newContext();
    try {
      if (cookies.length > 0) await context.addCookies(cookies);
      const page = await context.newPage();
      const html = await withTimeout(loadPage(page, url, timeoutMs), timeoutMs + 10000, `get ${url}`);
      const newCookies = await context.cookies();
      return { html, cookies: newCookies };
    } finally {
      await context.close();
    }
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
