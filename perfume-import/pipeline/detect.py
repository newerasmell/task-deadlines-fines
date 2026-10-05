"""Learn a store profile from its own Shopify export (SPEC §2).

Every profile item carries the detected value, how much of the catalog follows it (match_rate), examples and
a status: items below 90% are suggestions the team confirms in the app. Nothing here is store-specific.
"""

import math
import re
from collections import Counter
from datetime import UTC, datetime

from pipeline import ean, lang
from pipeline.config import Group
from pipeline.export import Export
from pipeline.markets import MARKETS
from pipeline.text import percentile, slugify, strip_html
from pipeline.titles import ABBREVIATIONS, parse_title
from pipeline.vocab import LearnedVocab

CONFIRM_BELOW = 0.9
NOTE_KEYS = ("top_note", "middle_note", "base_note")
SENTENCE = re.compile(r"(?<=[.!?])\s+")

# Columns that describe one product rather than the store's template; never "fixed".
PRODUCT_COLUMNS = {
    "Handle",
    "Title",
    "Body (HTML)",
    "Vendor",
    "Type",
    "Tags",
    "Published",
    "Status",
    "Variant SKU",
    "Variant Price",
    "Variant Compare At Price",
    "Variant Barcodes",
    "Variant Inventory Qty",
    "Variant Image",
    "Image Src",
    "Image Position",
    "Image Alt Text",
    "SEO Title",
    "SEO Description",
    "Cost per item",
    "Google Shopping / Gender",
    "Google Shopping / MPN",
}


def item(value, rate: float | None, examples: list | None = None, **details) -> dict:
    out = {
        "value": value,
        "match_rate": None if rate is None else round(rate, 3),
        "status": "ok" if rate is not None and rate >= CONFIRM_BELOW else "suggested",
        "examples": (examples or [])[:5],
    }
    out.update(details)
    return out


def _share(counter: Counter, value) -> float:
    total = sum(counter.values())
    return counter[value] / total if total else 0.0


def _num(s: str) -> float | None:
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def sku_key(product: dict) -> str:
    return ean.clean(product.get("Variant SKU"))


def unique_by_sku(export: Export) -> dict[str, dict]:
    counts = Counter(sku_key(p) for p in export.products)
    return {sku_key(p): p for p in export.products if sku_key(p) and counts[sku_key(p)] == 1 and sku_key(p) != "NAN"}


# ---- individual detectors ------------------------------------------------------------------------


def detect_title(export: Export) -> dict:
    parsed = [parse_title(p["Title"], p.get("Vendor", "")) for p in export.products]
    shapes = Counter(p.shape for p in parsed)
    top, _ = shapes.most_common(1)[0]
    markers = Counter(p.tester for p in parsed if p.tester)
    marker = markers.most_common(1)[0][0] if markers else None
    formula = top + (f"{{tester: ' {marker}'}}" if marker else "")
    off = [p.title for p in parsed if p.shape != top]

    forms = Counter(p.concentration for p in parsed if p.concentration)
    short = {}
    for abbr, full in ABBREVIATIONS.items():
        if forms[abbr] and forms[abbr] >= forms[full]:
            short[full] = abbr
    kept_full = sorted(f for f in forms if f not in ABBREVIATIONS and f not in short)

    names = " ".join(p.name for p in parsed if p.name)
    chunks = [" ".join(p.name for p in parsed[i : i + 25]) for i in range(0, len(parsed), 25)]
    title_lang, title_lang_rate, _ = lang.dominant(chunks)
    return {
        "title_pattern": item(formula, _share(shapes, top), off, variants=dict(shapes.most_common(6))),
        "tester_marker": item(
            marker,
            _share(markers, marker) if marker else None,
            [m for m in markers if m != marker],
            counts=dict(markers),
        ),
        "concentration_short": item(
            short,
            sum(forms[a] for a in short.values()) / max(1, sum(forms[a] + forms[f] for f, a in short.items())),
            kept_full=kept_full,
            forms=dict(forms.most_common()),
        ),
        "title_language": item(title_lang or lang.detect(names[:2000]), title_lang_rate),
    }


def detect_handle(export: Export) -> dict:
    off = [(p["Handle"], p["Title"]) for p in export.products if p["Handle"] != slugify(p["Title"])]
    rate = 1 - len(off) / max(1, len(export.products))
    return {"handle": item("slug(title)", rate, [f"{h} ← {t}" for h, t in off])}


def detect_ean_and_sku(export: Export) -> dict:
    candidates = {}
    for col in ["Variant Barcodes", *(mf.column for mf in export.metafields)]:
        values = [ean.clean(p.get(col)) for p in export.products]
        filled = [v for v in values if v]
        if not filled or sum(v.isdigit() for v in filled) / len(filled) < 0.8:
            continue
        valid = sum(ean.is_valid(v) for v in filled)
        candidates[col] = {"filled": len(filled), "valid_checksum": valid}
    if not candidates:
        return {"ean_location": item(None, 0.0), "sku_pattern": item(None, 0.0)}
    location = max(candidates, key=lambda c: candidates[c]["valid_checksum"])
    stats = candidates[location]

    templates, off = Counter(), []
    for p in export.products:
        code = ean.clean(p.get(location))
        if not code:
            continue
        sku = ean.clean(p.get("Variant SKU"))
        m = re.fullmatch(r"([A-Za-z]*)(\d+)([A-Za-z]*)", sku)
        if m and m.group(2) == code:
            templates[f"{m.group(1)}{{ean}}{m.group(3)}"] += 1
        else:
            templates["(друго)"] += 1
            off.append(f"SKU {p.get('Variant SKU') or '—'} / EAN {code} · {p['Title']}")
    top = templates.most_common(1)[0][0]
    return {
        "ean_location": item(
            _location_name(location),
            stats["valid_checksum"] / stats["filled"],
            column=location,
            coverage=round(stats["filled"] / len(export.products), 3),
            candidates={_location_name(c): s for c, s in candidates.items()},
        ),
        "sku_pattern": item(top, _share(templates, top), off, variants=dict(templates)),
    }


def _location_name(column: str) -> str:
    m = re.search(r"product\.metafields\.([\w-]+)\.([\w-]+)", column)
    return f"metafield {m.group(1)}.{m.group(2)}" if m else column


def detect_metafields(export: Export) -> dict:
    out = []
    n = max(1, len(export.products))
    for mf in export.metafields:
        values = [p.get(mf.column, "").strip() for p in export.products]
        filled = [v for v in values if v]
        out.append(
            {
                "namespace": mf.namespace,
                "key": mf.key,
                "label": mf.label,
                "type": _guess_type(filled),
                "filled_rate": round(len(filled) / n, 3),
            }
        )
    used = [m for m in out if m["filled_rate"] > 0]
    return {
        "metafields": item(out, len(used) / max(1, len(out)), used_keys=[f"{m['namespace']}.{m['key']}" for m in used])
    }


def _guess_type(values: list[str]) -> str:
    if not values:
        return "unknown"
    if all(re.fullmatch(r"-?\d+", v) for v in values):
        return "number_integer"
    if all(_num(v) is not None for v in values):
        return "number_decimal"
    if all(v.lower() in ("true", "false") for v in values):
        return "boolean"
    if any("\n" in v for v in values):
        return "multi_line_text_field"
    return "single_line_text_field"


def detect_vocab(export: Export, fields: list[str], reference: Export | None) -> dict:
    out = {}
    pairs_here = unique_by_sku(export) if reference else {}
    pairs_ref = unique_by_sku(reference) if reference else {}
    for key in fields:
        col = export.metafield_column(key)
        if not col:
            continue
        learned = LearnedVocab(Counter(p.get(col, "") for p in export.products))
        if reference and (ref_col := reference.metafield_column(key)):
            ref_vocab = LearnedVocab(Counter(p.get(ref_col, "") for p in reference.products))
            pairs = [(p[col], pairs_ref[k][ref_col]) for k, p in pairs_here.items() if k in pairs_ref]
            learned.apply_pairs(pairs, ref_vocab)
        profile = learned.as_profile()
        out[key] = item(
            sorted(profile["canonical"]),
            profile["resolved_rate"],
            [v for v in profile["translations"] if not profile["translations"][v]["maps_to"]],
            **profile,
        )
    return {"vocab": out}


def detect_language(export: Export, configured: str | None = None) -> dict:
    bodies = [strip_html(p.get("Body (HTML)", "")) for p in export.products]
    content, content_rate, counts = lang.dominant(bodies)
    off = [
        f"{p['Title']} ({code})"
        for p, b in zip(export.products, bodies, strict=True)
        if (code := lang.detect(b)) and code != content
    ]
    note_cols = [c for k in NOTE_KEYS if (c := export.metafield_column(k))]
    notes = [", ".join(p.get(c, "") for c in note_cols) for p in export.products]
    notes_lang, notes_rate, note_counts = lang.dominant([n for n in notes if len(n) >= 20])
    content_item = item(content, content_rate, off, counts=dict(counts.most_common()), configured=configured)
    if configured and content != configured:
        content_item["status"] = "suggested"
        content_item["message"] = (
            f"Конфигурацията казва „{configured}“, а {content_rate:.0%} от описанията са на „{content}“."
        )
    return {
        "content_language": content_item,
        "notes_language": item(notes_lang, notes_rate, counts=dict(note_counts.most_common())),
    }


def detect_markets(export: Export, country: str | None) -> dict:
    markets = []
    for name in export.markets:
        included = sum(p.get(f"Included / {name}", "").lower() == "true" for p in export.products)
        code, currency = MARKETS.get(name, (None, None))
        markets.append({"market": name, "country": code, "currency": currency, "included": included})
    if not markets:
        return {"markets": item([], None), "currency": item(None, None)}
    primary = next((m for m in markets if country and m["country"] == country), None)
    primary = primary or max(markets, key=lambda m: m["included"])
    rate = primary["included"] / max(1, len(export.products))
    return {
        "markets": item(markets, 1.0 if all(m["country"] for m in markets) else 0.0),
        # Exports carry no currency column; it comes from the primary market.
        "currency": item(
            primary["currency"],
            1.0 if primary["currency"] else 0.0,
            market=primary["market"],
            market_coverage=round(rate, 3),
        ),
    }


def detect_description(export: Export, content_language: str | None) -> dict:
    products = export.products
    texts = [strip_html(p.get("Body (HTML)", "")) for p in products]
    lengths = sorted(len(t) for t in texts if t)
    lo = int(math.floor(percentile(lengths, 0.05) / 10) * 10)
    hi = int(math.ceil(percentile(lengths, 0.95) / 10) * 10)
    in_range = sum(lo <= len(t) <= hi for t in texts if t) / max(1, len(lengths))

    shapes = Counter(_html_shape(p.get("Body (HTML)", "")) for p in products)
    shape, _ = shapes.most_common(1)[0]

    tester_sentence, tester_rate = _tester_sentence(products, texts)

    seo = sorted(len(p.get("SEO Description", "")) for p in products if p.get("SEO Description"))
    examples = _pick_examples(products, texts, lo, hi, shape, content_language)
    return {
        "description_length": item(
            [lo, hi],
            in_range,
            p5=percentile(lengths, 0.05),
            p50=percentile(lengths, 0.5),
            p95=percentile(lengths, 0.95),
            empty=len(texts) - len(lengths),
        ),
        "description_html": item(shape, _share(shapes, shape), variants=dict(shapes.most_common(5))),
        "tester_sentence": item(tester_sentence, tester_rate),
        "seo_description_length": item(
            int(percentile(seo, 0.95)) if seo else None,
            None,
            max=seo[-1] if seo else None,
            over_160=sum(n > 160 for n in seo),
        ),
        "description_examples": item(examples, None),
    }


def _html_shape(html: str) -> str:
    tags = re.findall(r"<\s*(\w+)", html or "")
    if not tags:
        return "без HTML" if (html or "").strip() else "празно"
    paragraphs = tags.count("p")
    others = sorted({t for t in tags if t != "p"})
    shape = f"{paragraphs} × <p>" if paragraphs else "без <p>"
    return shape + (f" + {', '.join('<' + t + '>' for t in others)}" if others else "")


def _tester_sentence(products: list[dict], texts: list[str]) -> tuple[str | None, float]:
    """The sentence testers get and regular products don't. It names the tester marker in some form."""
    tester, other, markers = Counter(), Counter(), set()
    n_tester = n_other = 0
    for p, t in zip(products, texts, strict=True):
        parsed = parse_title(p["Title"], p.get("Vendor", ""))
        text = t.replace(parsed.title, "{title}")
        found = {s.strip() for s in SENTENCE.split(text) if len(s.strip()) > 15}
        if parsed.tester:
            markers.add(parsed.tester.casefold())
            tester.update(found)
            n_tester += 1
        else:
            other.update(found)
            n_other += 1
    for sentence, n in tester.most_common():
        names_marker = any(m in sentence.casefold() for m in markers) and "{title}" not in sentence
        if names_marker and other[sentence] / max(1, n_other) < 0.05:
            return sentence, n / max(1, n_tester)
    return None, 0.0


def _pick_examples(products, texts, lo, hi, shape, language) -> list[dict]:
    """Five style references: in the store language, typical length and HTML, mix of tester and regular."""
    median = (lo + hi) / 2
    picked = {True: [], False: []}
    candidates = sorted(
        (abs(len(t) - median), i, p, t)
        for i, (p, t) in enumerate(zip(products, texts, strict=True))
        if lo <= len(t) <= hi and _html_shape(p.get("Body (HTML)", "")) == shape
    )
    for _, _, p, t in candidates:
        is_tester = parse_title(p["Title"], p.get("Vendor", "")).tester is not None
        if len(picked[is_tester]) >= (2 if is_tester else 3):
            continue
        if language and lang.detect(t) != language:
            continue
        picked[is_tester].append({"title": p["Title"], "body_html": p.get("Body (HTML)", "")})
        if len(picked[True]) >= 2 and len(picked[False]) >= 3:
            break
    return picked[False] + picked[True]


def detect_prices(export: Export) -> dict:
    prices = [(p, _num(p.get("Variant Price"))) for p in export.products]
    prices = [(p, v) for p, v in prices if v is not None]
    cents = Counter(f"{v:.2f}".split(".")[1] for _, v in prices)
    rounding, _ = cents.most_common(1)[0] if cents else (None, 0)

    ratios, bad = [], []
    for p, price in prices:
        compare = _num(p.get("Variant Compare At Price"))
        if compare is None or price <= 0:
            continue
        ratios.append(compare / price)
        if compare <= price:
            bad.append(f"{p['Title']}: {price:.2f} / {compare:.2f}")
    ratios.sort()
    lo = round(math.floor(percentile(ratios, 0.05) * 20) / 20, 2) if ratios else None
    hi = round(math.ceil(percentile(ratios, 0.95) * 20) / 20, 2) if ratios else None
    within = sum(lo <= r <= hi for r in ratios) / len(ratios) if ratios else None
    return {
        "price_rounding": item(
            rounding, _share(cents, rounding) if cents else None, endings=dict(cents.most_common(6))
        ),
        "compare_at_ratio": item(
            [lo, hi],
            within,
            bad,
            p50=round(percentile(ratios, 0.5), 3) if ratios else None,
            with_compare_at=round(len(ratios) / max(1, len(prices)), 3),
            compare_at_not_above_price=len(bad),
        ),
    }


def detect_fixed(export: Export, gender_vocab: LearnedVocab | None) -> dict:
    fixed = {}
    metafield_cols = {mf.column for mf in export.metafields}
    for col in export.columns:
        if (
            col in PRODUCT_COLUMNS
            or col in metafield_cols
            or " / " in col
            and col.split(" / ")[0]
            in (
                "Included",
                "Price",
                "Compare At Price",
            )
        ):
            continue
        counts = Counter(_normal(p.get(col, "")) for p in export.products)
        value, n = counts.most_common(1)[0]
        if value == "" or n / len(export.products) < 0.6:
            continue
        others = [f"{v or '(празно)'} × {c}" for v, c in counts.most_common(4) if v != value]
        fixed[col] = item(value, n / len(export.products), others)

    google_gender = {}
    if gender_vocab is not None and (col := export.metafield_column("gender")):
        pairs: dict[str, Counter] = {}
        for p in export.products:
            g = p.get("Google Shopping / Gender", "").strip()
            cluster = gender_vocab.lookup(p.get(col, ""))
            if g and cluster and not cluster.local:
                pairs.setdefault(cluster.canonical, Counter())[g] += 1
        google_gender = {k: c.most_common(1)[0][0] for k, c in pairs.items()}
        agree = sum(c.most_common(1)[0][1] for c in pairs.values()) / max(
            1, sum(sum(c.values()) for c in pairs.values())
        )
    return {
        "fixed_columns": fixed,
        "google_gender": item(google_gender, agree if google_gender else None),
    }


def _normal(value: str) -> str:
    v = value.strip()
    if re.fullmatch(r"-?\d+\.0", v):
        return v[:-2]
    return v


def detect_note_pairs(export: Export, reference: Export | None, here_lang: str | None, ref_lang: str | None) -> dict:
    """Same product in two stores -> its notes in two languages, position by position.

    A store writes notes either in English or in its own language, and that varies per product. Each side
    is classified as "en" or the store language, so "en→el" pairs give English canonical -> Greek for the
    glossary and "el→hr" pairs link two local languages."""
    if reference is None:
        return {"note_pairs": item({}, None)}
    here, there = unique_by_sku(export), unique_by_sku(reference)
    a_cols = [export.metafield_column(k) for k in NOTE_KEYS]
    b_cols = [reference.metafield_column(k) for k in NOTE_KEYS]
    if not all(a_cols) or not all(b_cols):
        return {"note_pairs": item({}, None)}
    buckets: dict[str, dict[str, Counter]] = {}
    for sku, p in here.items():
        if sku not in there:
            continue
        a_lang = _en_or(", ".join(p.get(c, "") for c in a_cols), here_lang)
        b_lang = _en_or(", ".join(there[sku].get(c, "") for c in b_cols), ref_lang)
        if not a_lang or not b_lang or a_lang == b_lang:
            continue
        for a_col, b_col in zip(a_cols, b_cols, strict=True):
            a = _split_notes(p.get(a_col, ""))
            b = _split_notes(there[sku].get(b_col, ""))
            if a and len(a) == len(b):
                bucket = buckets.setdefault(f"{b_lang}→{a_lang}", {})
                for here_term, there_term in zip(a, b, strict=True):
                    bucket.setdefault(there_term, Counter())[here_term] += 1
    out, consistent, total = {}, 0, 0
    for direction, pairs in sorted(buckets.items()):
        rows = []
        for term, partners in pairs.items():
            partner, n = partners.most_common(1)[0]
            count = sum(partners.values())
            rows.append({"term": term, "translation": partner, "count": count, "consistency": round(n / count, 3)})
            consistent += n / count >= CONFIRM_BELOW
            total += 1
        rows.sort(key=lambda r: (-r["count"], r["term"]))
        out[direction] = rows
    rate = consistent / total if total else None
    return {"note_pairs": item(out, rate, reference=str(reference.path.name))}


def _en_or(text: str, local: str | None) -> str | None:
    if len(text.strip()) < 15:
        return None
    return "en" if lang.detect(text, min_chars=15) == "en" else local


def local_language(export: Export, configured: str | None) -> str | None:
    """The store's own language: from config, else the most common non-English body language."""
    if configured:
        return configured
    counts = Counter(lang.detect(strip_html(p.get("Body (HTML)", ""))) for p in export.products)
    counts.pop(None, None)
    counts.pop("en", None)
    return counts.most_common(1)[0][0] if counts else None


def _split_notes(value: str) -> list[str]:
    return [t.strip().lower() for t in value.split(",") if t.strip()]


# ---- whole profile -------------------------------------------------------------------------------


def detect_profile(
    export: Export,
    store_key: str,
    group: Group | None = None,
    reference: Export | None = None,
) -> dict:
    store = group.stores.get(store_key) if group else None
    vocab_fields = list(group.vocab) if group and group.vocab else ["gender", "fragrance_family"]

    items: dict = {}
    items.update(detect_language(export, store.language if store else None))
    items.update(detect_markets(export, store.country if store else None))
    items.update(detect_title(export))
    items.update(detect_handle(export))
    items.update(detect_ean_and_sku(export))
    items.update(detect_metafields(export))
    items.update(detect_vocab(export, vocab_fields, reference))
    items.update(detect_description(export, items["content_language"]["value"]))
    items.update(detect_prices(export))
    gender_col = export.metafield_column("gender")
    gender_vocab = LearnedVocab(Counter(p.get(gender_col, "") for p in export.products)) if gender_col else None
    items.update(detect_fixed(export, gender_vocab))
    if reference is not None:
        ref_store = next((k for k in (group.stores if group else {}) if reference.path.name.startswith(k)), None)
        ref_lang = local_language(reference, group.stores[ref_store].language if ref_store else None)
        here_lang = local_language(export, store.language if store else None)
        items.update(detect_note_pairs(export, reference, here_lang, ref_lang))
    else:
        items.update(detect_note_pairs(export, None, None, None))

    to_confirm = sorted(
        k
        for k, v in items.items()
        if isinstance(v, dict) and v.get("status") == "suggested" and v.get("match_rate") is not None
    )
    return {
        "store": store_key,
        "group": group.key if group else None,
        "source": export.path.name,
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "products": len(export.products),
        "columns": export.columns,
        "items": items,
        "to_confirm": to_confirm,
    }
