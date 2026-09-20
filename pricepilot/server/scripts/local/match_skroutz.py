#!/usr/bin/env python3
"""
Standalone local matcher -- same calling convention as match_products.py
(--input / --index), same matching rules as PricePilot's own
jeftinijeMatcher.ts (this is a faithful Python port of it, not a
reimplementation from scratch): brand + exact ml + exact concentration
class + full agreement on the model-name tokens. No fuzzy scoring --
anything short of an exact match goes to the ambiguous queue for a human
to pick between, rather than being guessed.

Usage:
    python3 match_skroutz.py --input skroutz-gr-research-template.csv --index skroutz_gr_raw.csv

--input   PricePilot's own manual_import "Download template" export
          (columns: product_id, sku, vendor, title, size_ml, our_price, ...)
--index   Raw listings gathered by scrape_skroutz_gr.py
          (columns: vendor_searched, title, price_eur, url)
--out     Results CSV path (default: skroutz-gr-results.csv)
--out-ambiguous
          Ambiguous-candidates CSV path (default: skroutz-gr-ambiguous.csv,
          only written if there's at least one ambiguous product)

Output format matches exactly what PricePilot's manual_import source
expects back on its Import / Import ambiguous matches buttons -- upload
as-is, no hand editing needed.
"""

import argparse
import csv
import re
import unicodedata

# ---- textNormalize.ts port -------------------------------------------------

def normalize_text(s: str) -> str:
    nfd = unicodedata.normalize("NFD", s)
    stripped = "".join(c for c in nfd if unicodedata.category(c) != "Mn")
    lowered = stripped.lower()
    spaced = re.sub(r"[^a-z0-9]+", " ", lowered)
    return spaced.strip()


ML_PATTERN = re.compile(r"(\d+(?:[.,]\d+)?)\s*ml\b", re.IGNORECASE)


def extract_ml(s: str) -> float | None:
    m = ML_PATTERN.search(s)
    if not m:
        return None
    try:
        return float(m.group(1).replace(",", "."))
    except ValueError:
        return None


# ---- jeftinijeMatcher.ts port ----------------------------------------------

# Longer/more specific phrases first so e.g. "eau de parfum" is caught
# before a bare "parfum" match would misfire on it.
CONC_PATTERNS: list[tuple[str, list[str]]] = [
    ("EXTRAIT", ["extrait de parfum", "extrait", "esencia de parfum", "essence de parfum", "elixir de parfum"]),
    ("EDP", ["eau de parfum", "parfemska voda", "parfimirana voda", "edp", "parfumska voda", "parfemovana voda"]),
    ("EDT", ["eau de toilette", "toaletna voda", "edt", "toaletni voda"]),
    ("EDC", ["eau de cologne", "kolonjska voda", "edc", "cologne", "kolinska voda"]),
    ("PARFUM", ["parfum", "parfem"]),  # last: bare "parfum" is a weak signal
]

BRAND_ALIASES: dict[str, str] = {
    "ysl": "yves saint laurent",
    "yves saint laurent": "yves saint laurent",
    "armani": "armani",
    "giorgio armani": "armani",
    "emporio armani": "armani",
    "dior": "dior",
    "christian dior": "dior",
    "paco rabanne": "paco rabanne",
    "rabanne": "paco rabanne",
    "bvlgari": "bvlgari",
    "bulgari": "bvlgari",
    "d g": "dolce gabbana",
    "dolce gabbana": "dolce gabbana",
    "hugo boss": "hugo boss",
    "boss": "hugo boss",
    "by kilian": "by kilian",
    "kilian": "by kilian",
    "killian": "by kilian",
    "thierry mugler": "mugler",
    "mugler": "mugler",
    "estee lauder": "estee lauder",
    "maison francis kurkdjian": "mfk",
    "mfk": "mfk",
    "jean paul gaultier": "jean paul gaultier",
    "viktor rolf": "viktor rolf",
    "zadig voltaire": "zadig voltaire",
    "jo malone": "jo malone",
    "jo malone london": "jo malone",
}

GENERIC = {
    "za", "muskarce", "zene", "musko", "zensko", "men", "man", "woman", "women", "for", "him", "her",
    "pour", "homme", "femme", "unisex", "spray", "sprej", "natural", "vapo", "vaporisateur", "ml",
    "new", "original", "u", "i", "de", "o",
    # Czech gender adjectives (Heureka.cz titles always append one).
    "damska", "damsky", "panska", "pansky",
}

# A tester, a refill cartridge, and a sample vial are all cheaper, different
# products from a standard bottle even when brand/model/ml all line up.
VARIANT_MARKERS = ["tester", "napln", "vzorek"]

# Greek "Σετ" (set/bundle -- several items for one price) has no Latin
# script at all, so normalize_text's [^a-z0-9] filter erases it completely
# rather than leaving a strippable-but-detectable token the way "tester"
# survives -- confirmed live on a Skroutz.gr listing titled "... Σετ ...
# 2τμχ" ("... Set ... 2pcs"), which would otherwise normalize down to
# looking like a plain single-bottle listing. Checked against the raw
# (space-padded, lowercased) title before normalization can erase it --
# not a bare substring check, since "set" as a loose substring would
# misfire on ordinary words like "Sunset" or "Asset".
RAW_VARIANT_MARKERS = ["σετ", "set"]


def canon_brand(s: str) -> str:
    n = normalize_text(s)
    return BRAND_ALIASES.get(n, n)


def extract_conc(s: str) -> str | None:
    n = f" {normalize_text(s)} "
    for label, patterns in CONC_PATTERNS:
        for p in patterns:
            if f" {p} " in n:
                return label
    return None


def variant_tag(title: str) -> str | None:
    padded = f" {title.lower()} "
    for marker in RAW_VARIANT_MARKERS:
        if f" {marker} " in padded:
            return marker
    n = normalize_text(title)
    for marker in VARIANT_MARKERS:
        if marker in n:
            return marker
    return None


def brand_aliases_for(brand: str) -> list[str]:
    canonical = canon_brand(brand)
    aliases = {normalize_text(brand), canonical}
    for alias, canon in BRAND_ALIASES.items():
        if canon == canonical:
            aliases.add(alias)
    return sorted(aliases, key=len, reverse=True)


NUM_ML_RE = re.compile(r"\b\d+(?:[.,]\d+)?\s*ml\b")
BARE_NUM_RE = re.compile(r"\b\d+(?:[.,]\d+)?\b")


def model_tokens(title: str, brand: str) -> list[str]:
    n = f" {normalize_text(title)} "
    for alias in brand_aliases_for(brand):
        n = n.replace(f" {alias} ", " ")
    for _, patterns in CONC_PATTERNS:
        for p in patterns:
            n = n.replace(f" {p} ", " ")
    n = NUM_ML_RE.sub(" ", n)
    n = BARE_NUM_RE.sub(" ", n)
    tokens = [t for t in n.split() if len(t) > 1 and t not in GENERIC]
    return sorted(set(tokens))


def same_tokens(a: list[str], b: list[str]) -> bool:
    return a == b


class IndexEntry:
    __slots__ = ("title", "url", "price", "n_title", "ml", "conc", "variant")

    def __init__(self, title: str, url: str, price: float | None):
        self.title = title
        self.url = url
        self.price = price
        self.n_title = normalize_text(title)
        ml = extract_ml(title)
        self.ml = ml
        self.conc = extract_conc(title)
        self.variant = variant_tag(title)


def build_match_index(listings: list[dict]) -> list[IndexEntry]:
    return [IndexEntry(l["title"], l["url"], l["price"]) for l in listings if l["title"]]


class MatchCandidate:
    def __init__(self, title: str, price: float | None, url: str, size_unconfirmed: bool):
        self.title = title
        self.price = price
        self.url = url
        self.size_unconfirmed = size_unconfirmed


def to_candidate(c: IndexEntry, our_ml: float | None) -> MatchCandidate:
    return MatchCandidate(c.title, c.price, c.url, our_ml is not None and c.ml is None)


def match_product(title: str, vendor: str | None, index: list[IndexEntry]):
    """Returns ("found", price, url) | ("ambiguous", [MatchCandidate]) | ("not_found",)"""
    brand = canon_brand(vendor or "")
    if not brand:
        return ("not_found",)
    brand_first_word = brand.split(" ")[0]

    ml = extract_ml(title)
    our_conc = extract_conc(title)
    our_model = model_tokens(title, vendor or "")
    our_variant = variant_tag(title)

    pool = [c for c in index if brand_first_word in c.n_title]
    if " " in brand:
        pool = [c for c in pool if brand in c.n_title]
    if ml is not None:
        pool = [c for c in pool if c.ml == ml or c.ml is None]
    if not pool:
        return ("not_found",)

    exact: list[IndexEntry] = []
    near: list[IndexEntry] = []

    for c in pool:
        if c.variant != our_variant:
            continue
        if our_conc and c.conc and our_conc != c.conc:
            pair = {our_conc, c.conc}
            if pair != {"PARFUM", "EXTRAIT"}:
                continue
        ml_unconfirmed = ml is not None and c.ml is None
        c_model = model_tokens(c.title, vendor or "")
        if same_tokens(c_model, our_model):
            if ml_unconfirmed:
                near.append(c)
            elif our_conc and c.conc and our_conc == c.conc:
                exact.append(c)
            elif not our_conc and not c.conc:
                exact.append(c)
            else:
                near.append(c)
        else:
            a, b = set(c_model), set(our_model)
            subset = a.issubset(b) or b.issubset(a)
            if a and b and subset and abs(len(a) - len(b)) <= 1:
                near.append(c)

    if exact:
        priced = [c for c in exact if c.price is not None]
        if priced:
            best = min(priced, key=lambda c: c.price)
            return ("found", best.price, best.url)
        candidates = [to_candidate(c, ml) for c in (exact + near)[:5]]
        return ("ambiguous", candidates)
    if near:
        candidates = [to_candidate(c, ml) for c in near[:5]]
        return ("ambiguous", candidates)
    return ("not_found",)


# ---- CSV I/O ----------------------------------------------------------------

def fmt_price(p: float | None) -> str:
    if p is None:
        return ""
    return str(int(p)) if p == int(p) else str(p)


RESULTS_HEADER = [
    "product_id", "sku", "vendor", "title", "size_ml", "our_price",
    "search_url", "competitor_price", "competitor_url", "not_found",
]
AMBIGUOUS_HEADER = ["product_id", "candidate_title", "candidate_url", "candidate_price"]


def load_products(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    out = []
    for row in rows:
        normalized = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
        if not normalized.get("product_id"):
            continue
        out.append(normalized)
    return out


def load_raw_listings(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    out = []
    for row in rows:
        title = (row.get("title") or "").strip()
        url = (row.get("url") or "").strip()
        price_raw = row.get("price_eur") or row.get("price") or ""
        try:
            price = float(price_raw) if price_raw else None
        except ValueError:
            price = None
        if title and url:
            out.append({"title": title, "url": url, "price": price})
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="PricePilot products CSV (manual_import template)")
    parser.add_argument("--index", required=True, help="Raw listings CSV from scrape_skroutz_gr.py")
    parser.add_argument("--out", default="skroutz-gr-results.csv")
    parser.add_argument("--out-ambiguous", default="skroutz-gr-ambiguous.csv")
    args = parser.parse_args()

    products = load_products(args.input)
    print(f"loaded {len(products)} products from {args.input}")

    raw_listings = load_raw_listings(args.index)
    print(f"loaded {len(raw_listings)} raw listings from {args.index}")

    index = build_match_index(raw_listings)

    results_rows = []
    ambiguous_rows = []
    found = ambiguous = not_found = 0

    for p in products:
        result = match_product(p["title"], p.get("vendor") or None, index)
        if result[0] == "found":
            found += 1
            _, price, url = result
            results_rows.append([
                p["product_id"], p.get("sku", ""), p.get("vendor", ""), p["title"],
                p.get("size_ml", ""), p.get("our_price", ""), p.get("search_url", ""),
                fmt_price(price), url, "",
            ])
        elif result[0] == "ambiguous":
            ambiguous += 1
            results_rows.append([
                p["product_id"], p.get("sku", ""), p.get("vendor", ""), p["title"],
                p.get("size_ml", ""), p.get("our_price", ""), p.get("search_url", ""),
                "", "", "yes",
            ])
            for c in result[1]:
                ambiguous_rows.append([p["product_id"], c.title, c.url, fmt_price(c.price)])
        else:
            not_found += 1
            results_rows.append([
                p["product_id"], p.get("sku", ""), p.get("vendor", ""), p["title"],
                p.get("size_ml", ""), p.get("our_price", ""), p.get("search_url", ""),
                "", "", "yes",
            ])

    with open(args.out, "w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(RESULTS_HEADER)
        writer.writerows(results_rows)
    print(f"wrote {len(results_rows)} rows to {args.out}")

    if ambiguous_rows:
        with open(args.out_ambiguous, "w", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(AMBIGUOUS_HEADER)
            writer.writerows(ambiguous_rows)
        print(f"wrote {len(ambiguous_rows)} candidate rows to {args.out_ambiguous}")

    print(f"summary: found={found} ambiguous={ambiguous} not_found={not_found}")


if __name__ == "__main__":
    main()
