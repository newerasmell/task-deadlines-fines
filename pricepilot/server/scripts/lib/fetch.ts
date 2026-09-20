import { BrowserSession, type PersistentPage } from "../../src/lib/browserFetch";
import { politeGet, sleep } from "../../src/lib/httpClient";
import type { SiteConfig } from "./types";

// A locale-aware plain fetch — httpClient.ts's politeGet() hardcodes
// hr-HR, which is wrong for the other 6 sites here.
async function politeGetLocalized(url: string, locale: string, timeoutMs = 15000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": `${locale},en-US;q=0.8,en;q=0.7`,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// One fetcher per script run, reused across every page of every category —
// same "one persistent browser session" pattern buildJeftinijeIndex() uses,
// so a multi-page crawl looks like one continuous visit instead of a fresh
// cookie-less session per request.
export class SiteFetcher {
  private browser: BrowserSession | null = null;
  private page: PersistentPage | null = null;

  constructor(private site: SiteConfig) {}

  private async persistentPage(): Promise<PersistentPage> {
    if (!this.page) {
      this.browser = new BrowserSession();
      this.page = await this.browser.newPersistentPage();
    }
    return this.page;
  }

  async get(url: string): Promise<string> {
    if (this.site.needsBrowser) {
      const page = await this.persistentPage();
      return page.goto(url);
    }
    return politeGetLocalized(url, this.site.locale);
  }

  async close(): Promise<void> {
    if (this.page) await this.page.close();
    if (this.browser) await this.browser.close();
  }
}

export { sleep };
