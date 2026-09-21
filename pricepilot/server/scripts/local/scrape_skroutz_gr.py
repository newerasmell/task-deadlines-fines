#!/usr/bin/env python3
"""
Standalone local scraper for Skroutz.gr (Greek price comparison). Run this
on your own machine, NOT inside a sandboxed session -- it opens a real,
visible Chromium window (headed mode) specifically so you can click through
Cloudflare's "Verify you are human" checkbox by hand if it shows up. Same
pattern as scrape_heureka_cz.py / scrape_jeftinije_playwright.py.

It does NOT do the brand/size/concentration matching against your catalog --
it only crawls Skroutz.gr and saves what it finds (title, price in EUR, URL)
to a CSV. Run match_skroutz.py separately on the result (no network needed
for that part).

Setup (one time):
    pip3 install playwright
    python3 -m playwright install chromium

Usage:
    python3 scrape_skroutz_gr.py --headed skroutz-gr-research-template.csv

    Quick one-brand test (skips the CSV entirely):
    python3 scrape_skroutz_gr.py --headed --brand Armani

Output:
    skroutz_gr_raw.csv in the current directory (vendor_searched, title,
    price_eur, url). Safe to re-run: brands already in the output file are
    skipped, so a run that gets interrupted partway can just be started
    again.
"""

from __future__ import annotations

import argparse
import csv
import time
from pathlib import Path
from urllib.parse import quote, urljoin, urlsplit, urlunsplit

from playwright.sync_api import sync_playwright

BASE = "https://www.skroutz.gr"
OUT_FILE = Path("skroutz_gr_raw.csv")
MAX_PAGES_PER_BRAND = 15
POLITE_DELAY_SECONDS = 2.5


def load_vendors(csv_path: str) -> list[str]:
    vendors = []
    seen = set()
    with open(csv_path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            vendor = (row.get("vendor") or "").strip()
            if vendor and vendor.lower() not in seen:
                seen.add(vendor.lower())
                vendors.append(vendor)
    return vendors


def already_scraped_vendors() -> set[str]:
    if not OUT_FILE.exists():
        return set()
    with open(OUT_FILE, encoding="utf-8") as f:
        return {row["vendor_searched"] for row in csv.DictReader(f)}


def parse_price_eur(text: str) -> float | None:
    # "81,61 €" -- European comma-decimal, single price per listing (each
    # card is one specific shop's offer, not a multi-shop aggregate).
    cleaned = text.replace(" ", " ").replace("€", "").strip().replace(",", ".")
    try:
        return float(cleaned)
    except ValueError:
        return None


def strip_tracking_params(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def is_cloudflare_challenge(page) -> bool:
    try:
        html = page.content()
        return "_cf_chl_opt" in html or "challenges.cloudflare.com" in html or "Just a moment" in html
    except Exception:
        return False


def wait_for_human_if_challenged(page, vendor: str) -> None:
    if not is_cloudflare_challenge(page):
        return
    print(f"\n>>> Cloudflare check appeared while searching '{vendor}'.")
    print(">>> Look at the browser window and click 'Verify you are human' if you see it.")
    print(">>> Waiting up to 90 seconds for the page to clear...")
    for _ in range(90):
        time.sleep(1)
        if not is_cloudflare_challenge(page):
            print(">>> Cleared, continuing.\n")
            return
    print(">>> Still not cleared after 90s -- continuing anyway, this brand may come back empty.\n")


def extract_listings(page) -> list[dict]:
    out = []
    cards = page.locator('li[data-testid="sku-cardd"]')
    count = cards.count()
    for i in range(count):
        card = cards.nth(i)
        title_link = card.locator('a[data-testid="sku-title-link"]').first
        if title_link.count() == 0:
            continue
        h2 = title_link.locator("h2").first
        title = (h2.inner_text().strip() if h2.count() > 0 else "") or (title_link.get_attribute("title") or "").strip()
        if not title:
            continue

        price_el = card.locator('a[data-e2e-testid="sku-price-link"]').first
        price_eur = parse_price_eur(price_el.inner_text()) if price_el.count() > 0 else None
        if price_eur is None:
            continue  # no live offer on this card

        href = title_link.get_attribute("href")
        if not href:
            continue
        url = strip_tracking_params(urljoin(BASE, href))

        out.append({"title": title, "price_eur": price_eur, "url": url})
    return out


# Confirmed live in the real page's own category-nav links: fragrances
# split into these two categories -- no single umbrella category covers
# both without also pulling in unrelated cosmetics. A brand name alone
# against the site-wide /search endpoint is FAR too broad -- confirmed
# live that "Calvin Klein" through plain search returns underwear and
# watches alongside its handful of actual fragrances. Scoping to these
# category pages (?keyphrase=<brand> inside them, not a site-wide search)
# keeps every result an actual fragrance.
FRAGRANCE_CATEGORIES = ["/c/1776/Andrika-aromata.html", "/c/1777/Gynaikeia-aromata.html"]


def crawl_brand_in_category(page, vendor: str, category: str) -> list[dict]:
    search_url = f"{BASE}{category}?keyphrase={quote(vendor)}"
    print(f"[{vendor}] {search_url}")
    page.goto(search_url, wait_until="domcontentloaded", timeout=30000)
    wait_for_human_if_challenged(page, vendor)
    page.wait_for_timeout(1500)

    all_listings = extract_listings(page)
    print(f"[{vendor}]   page 1: {len(all_listings)} listings")

    seen_urls = {l["url"] for l in all_listings}
    for pnum in range(2, MAX_PAGES_PER_BRAND + 1):
        time.sleep(POLITE_DELAY_SECONDS)
        page.goto(f"{search_url}&page={pnum}", wait_until="domcontentloaded", timeout=30000)
        wait_for_human_if_challenged(page, vendor)
        page.wait_for_timeout(1000)
        page_listings = extract_listings(page)
        new = [l for l in page_listings if l["url"] not in seen_urls]
        if not new:
            break
        for l in new:
            seen_urls.add(l["url"])
        all_listings.extend(new)
        print(f"[{vendor}]   page {pnum}: {len(new)} new listings")

    return all_listings


def crawl_brand(page, vendor: str) -> list[dict]:
    seen_urls: set[str] = set()
    combined: list[dict] = []
    for category in FRAGRANCE_CATEGORIES:
        for l in crawl_brand_in_category(page, vendor, category):
            if l["url"] not in seen_urls:
                seen_urls.add(l["url"])
                combined.append(l)
    return combined


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("csv_path", nargs="?", help="Path to skroutz-gr-research-template.csv")
    parser.add_argument("--brand", help="Only search this one brand, ignore the CSV entirely (quick test)")
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Show the browser window (default -- needed so you can click through Cloudflare by hand)",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Hide the browser window. Don't use this until a --headed run has proven Cloudflare isn't showing up.",
    )
    args = parser.parse_args()

    if args.brand:
        todo = [args.brand]
        print(f"Testing one brand only: {args.brand}\n")
    else:
        if not args.csv_path:
            parser.error("either a csv_path or --brand is required")
        vendors = load_vendors(args.csv_path)
        done = already_scraped_vendors()
        todo = [v for v in vendors if v not in done]
        print(f"{len(vendors)} vendors in catalog, {len(done)} already scraped, {len(todo)} to go.\n")

    write_header = not OUT_FILE.exists()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=args.headless)
        context = browser.new_context(locale="el-GR")
        page = context.new_page()

        with open(OUT_FILE, "a", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=["vendor_searched", "title", "price_eur", "url"])
            if write_header:
                writer.writeheader()

            for vendor in todo:
                try:
                    listings = crawl_brand(page, vendor)
                except Exception as e:
                    print(f"[{vendor}] FAILED: {e}")
                    continue
                for l in listings:
                    writer.writerow({"vendor_searched": vendor, **l})
                f.flush()
                time.sleep(POLITE_DELAY_SECONDS)

        browser.close()

    print(f"\nDone. Results saved to {OUT_FILE.resolve()}")


if __name__ == "__main__":
    main()
