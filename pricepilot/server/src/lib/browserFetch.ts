import { chromium, type Browser, type BrowserContext } from "playwright";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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

  async get(url: string, timeoutMs = 30000): Promise<string> {
    const browser = await this.browser();
    const context: BrowserContext = await browser.newContext({
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
    try {
      const page = await context.newPage();
      // "networkidle" (not "domcontentloaded") — confirmed live that most
      // pages now load successfully (no more blocking) but the price still
      // isn't showing up in page.content(), consistent with a search-results
      // page that renders its listings via a follow-up XHR/fetch after the
      // initial HTML arrives. This waits for that to settle before reading
      // the DOM, at the cost of being slower per page.
      const res = await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs });
      if (res && !res.ok()) {
        throw new Error(`HTTP ${res.status()} fetching ${url}`);
      }
      return await page.content();
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
