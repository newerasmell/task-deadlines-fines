import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function loadPage(page: Page, url: string, timeoutMs: number): Promise<string> {
  const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  if (res && !res.ok()) {
    throw new Error(`HTTP ${res.status()} fetching ${url}`);
  }
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
    return context;
  }

  async get(url: string, timeoutMs = 30000): Promise<string> {
    const context = await this.newContext();
    try {
      const page = await context.newPage();
      return await loadPage(page, url, timeoutMs);
    } finally {
      await context.close();
    }
  }

  // A fresh incognito context per single navigation (what get() above does)
  // means every request — including page 2 of the same listing a real
  // visitor just paginated into from page 1 — shows up as a brand-new,
  // cookie-less "first visit". Confirmed live against jeftinije.hr: that
  // pattern gets 403'd on some requests that succeed fine when opened by
  // hand, where a hand-opened browser naturally carries cookies/session
  // continuity across pages. A PersistentPage instead keeps ONE context (and
  // its cookies) alive across every navigation the caller makes with it, so
  // a multi-page crawl actually looks like one continuous browsing session.
  async newPersistentPage(): Promise<PersistentPage> {
    const context = await this.newContext();
    const page = await context.newPage();
    return new PersistentPage(context, page);
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

export class PersistentPage {
  constructor(private context: BrowserContext, private page: Page) {}

  async goto(url: string, timeoutMs = 30000): Promise<string> {
    return loadPage(this.page, url, timeoutMs);
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
