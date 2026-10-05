"""Compare a detected store profile with a group's config (the seed in config/groups/group-1).

Each check says what the config has, what the export shows, and whether they agree. Disagreements are not
"fixed" in either direction here: they are reported so the team decides which one is right.
"""

from dataclasses import dataclass

from pipeline.config import Group
from pipeline.export import METAFIELD_COLUMN


@dataclass
class Check:
    item: str
    config: object
    detected: object
    agrees: bool
    rate: float | None = None
    note: str = ""


def _norm(v) -> str:
    return str(v).strip().lower()


def compare(profile: dict, group: Group) -> list[Check]:
    spec = group.spec
    items = profile["items"]
    store = group.stores.get(profile["store"])
    checks: list[Check] = []

    def add(name, config, detected, agrees, rate=None, note=""):
        checks.append(Check(name, config, detected, bool(agrees), rate, note))

    def rate(key):
        return items[key]["match_rate"]

    add(
        "title",
        spec.title,
        items["title_pattern"]["value"],
        items["title_pattern"]["value"] == spec.title,
        rate("title_pattern"),
    )
    add(
        "handle",
        spec.handle,
        items["handle"]["value"],
        items["handle"]["value"] == spec.handle,
        rate("handle"),
    )
    add(
        "sku",
        spec.sku,
        items["sku_pattern"]["value"],
        items["sku_pattern"]["value"] == spec.sku,
        rate("sku_pattern"),
    )
    ean_mf = next((k for k, v in spec.metafields.items() if v == "{ean}"), None)
    add(
        "ean_location",
        f"metafield custom.{ean_mf}" if ean_mf else None,
        items["ean_location"]["value"],
        items["ean_location"]["value"] == f"metafield custom.{ean_mf}",
        rate("ean_location"),
    )
    add(
        "concentration_short",
        spec.concentration_short,
        items["concentration_short"]["value"],
        items["concentration_short"]["value"] == spec.concentration_short,
        rate("concentration_short"),
    )
    add(
        "title_language",
        spec.title_language,
        items["title_language"]["value"],
        items["title_language"]["value"] == spec.title_language,
        rate("title_language"),
    )
    if store:
        lang = items["content_language"]
        add(
            "content_language",
            store.language,
            lang["value"],
            lang["value"] == store.language,
            lang["match_rate"],
        )
        add(
            "currency",
            store.currency,
            items["currency"]["value"],
            items["currency"]["value"] == store.currency,
        )

    # Metafields: the export's metafield columns are the template's, and every group.yaml metafield is used.
    template_mf = {
        f"{m['namespace']}.{m['key']}" for c in group.template_columns if (m := METAFIELD_COLUMN.match(c))
    }
    detected_mf = {f"{m['namespace']}.{m['key']}" for m in items["metafields"]["value"]}
    add("metafield_set", sorted(template_mf), sorted(detected_mf), template_mf == detected_mf)
    used = set(items["metafields"]["used_keys"])
    seed_custom = {f"custom.{k}" for k in spec.metafields}
    add("metafields_used", sorted(seed_custom), sorted(used & seed_custom), seed_custom <= used)

    for column, value in spec.fixed.items():
        found = items["fixed_columns"].get(column)
        add(
            f"fixed: {column}",
            value,
            found["value"] if found else None,
            found is not None and _norm(found["value"]) == _norm(value),
            found["match_rate"] if found else None,
        )
    google = spec.google
    for column, key in (
        ("Google Shopping / Google Product Category", "product_category"),
        ("Google Shopping / Condition", "condition"),
    ):
        found = items["fixed_columns"].get(column)
        add(
            f"google.{key}",
            google.get(key),
            found["value"] if found else None,
            found is not None and _norm(found["value"]) == _norm(google.get(key)),
            found["match_rate"] if found else None,
        )
    add(
        "google.gender",
        google.get("gender"),
        items["google_gender"]["value"],
        items["google_gender"]["value"] == google.get("gender"),
        items["google_gender"]["match_rate"],
    )

    lo, hi = spec.description.length
    d = items["description_length"]
    add(
        "description.length",
        [lo, hi],
        d["value"],
        d["value"] == [lo, hi],
        d["match_rate"],
        f"медиана {d['p50']} знака; p5–p95 {d['p5']}–{d['p95']}",
    )
    html = items["description_html"]
    add(
        "description.html",
        spec.description.html,
        html["value"],
        html["value"] == "1 × <p>",
        html["match_rate"],
    )
    tester = items["tester_sentence"]
    add(
        "description.tester_sentence",
        "задължително за тестери (description.md)",
        tester["value"],
        tester["value"] is not None and (tester["match_rate"] or 0) >= 0.9,
        tester["match_rate"],
    )

    rlo, rhi = spec.rules.compare_at_ratio
    r = items["compare_at_ratio"]
    add(
        "rules.compare_at_ratio",
        [rlo, rhi],
        r["value"],
        r["value"] == [rlo, rhi],
        r["match_rate"],
        f"медиана {r['p50']}",
    )
    if store and store.price.rounding:
        p = items["price_rounding"]
        add(
            "price.rounding",
            store.price.rounding,
            p["value"],
            p["value"] == store.price.rounding,
            p["match_rate"],
        )

    for field, seed in group.vocab.items():
        checks.extend(compare_vocab(field, seed, items["vocab"].get(field)))
    return checks


def compare_vocab(field: str, seed: dict[str, list[str]], detected: dict | None) -> list[Check]:
    if detected is None:
        return [Check(f"vocab.{field}", "в конфигурацията", None, False, note="полето липсва в експорта")]
    canonical = detected["canonical"]
    translations = detected["translations"]
    seen_as = {}
    for name, info in canonical.items():
        seen_as[name] = name
        for v in info["variants"]:
            seen_as[v] = name
    for v, info in translations.items():
        seen_as.setdefault(v, info["maps_to"])

    def count_in_data(value: str) -> int:
        if value in canonical:
            return canonical[value]["variants"].get(value, 0) + (
                canonical[value]["count"] - sum(canonical[value]["variants"].values())
            )
        for info in canonical.values():
            if value in info["variants"]:
                return info["variants"][value]
        if value in translations:
            return translations[value]["count"]
        return sum(tail.get(value, 0) for tail in detected["long_tail"].values())

    checks = []
    for c, variants in seed.items():
        if c in canonical:
            checks.append(Check(f"vocab.{field}: {c}", c, c, True, note=f"{canonical[c]['count']} продукта"))
        else:
            n = count_in_data(c) + sum(count_in_data(v) for v in variants)
            note = "рядко в данните (< 3)" if n < 3 else "не е открита като каноничнa стойност"
            checks.append(
                Check(f"vocab.{field}: {c}", c, seen_as.get(c), n < 3, note=f"{note}; {n} продукта")
            )
        for v in variants:
            if count_in_data(v) == 0:
                continue  # variant not used in this store
            got = seen_as.get(v)
            if got == c:
                checks.append(Check(f"vocab.{field}: {v}", c, got, True, note="вариант"))
            elif v in translations and got is None:
                checks.append(
                    Check(f"vocab.{field}: {v}", c, None, False, note="превод без английска връзка в данните")
                )
            else:
                checks.append(Check(f"vocab.{field}: {v}", c, got, False, note="съпоставен различно"))
    extra = sorted(set(canonical) - set(seed))
    if extra:
        checks.append(
            Check(
                f"vocab.{field}: нови канонични",
                "—",
                extra,
                False,
                note="стойности с ≥ 3 продукта, които ги няма във vocab.yaml",
            )
        )
    return checks
