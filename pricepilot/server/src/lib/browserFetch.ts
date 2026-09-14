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
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        // Unset in production — Playwright resolves its own downloaded
        // browser there. Only used for local/sandbox dev environments where
        // the installed browser build doesn't match this playwright
        // version's expected default path.
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
      });
    }
    return this.browserPromise;
  }

  async get(url: string, timeoutMs = 20000): Promise<string> {
    const browser = await this.browser();
    const context: BrowserContext = await browser.newContext({
      userAgent: USER_AGENT,
      locale: "hr-HR",
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { "Accept-Language": "hr-HR,hr;q=0.9,en-US;q=0.8,en;q=0.7" },
    });
    try {
      const page = await context.newPage();
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      if (res && !res.ok()) {
        throw new Error(`HTTP ${res.status()} fetching ${url}`);
      }
      // Brief settle window for any client-rendered price widgets that
      // finish just after DOMContentLoaded.
      await page.waitForTimeout(500);
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
