"""Which group a store belongs to (SPEC §8.7): its export compared with every group's structure.

A group shares columns (import_template.csv), metafields (group.yaml) and the title and SKU formulas; what is
per store (language, currency, markets, prices) does not count. A group without group.yaml yet (group-2) can
only be described, not compared.
"""

from pipeline.config import Group

RECOMMEND_AT = 0.8


def _metafield_keys(profile: dict) -> set[str]:
    items = profile.get("items", {})
    value = (items.get("metafields") or {}).get("value") or []
    return {m["key"] for m in value if m.get("namespace") == "custom" and m.get("key") != "sklad"}


def _value(profile: dict, key: str):
    return (profile.get("items", {}).get(key) or {}).get("value")


def score(profile: dict, group: Group) -> dict:
    if group.spec is None:
        stores = ", ".join(s.label.split(" (")[0] for s in group.stores.values())
        return {
            "group": group.key,
            "name": group.key,
            "score": None,
            "recommended": False,
            "comparable": False,
            "reasons": [
                f"{len(group.stores)} магазина: {stores}. Структурата ще се сравни, щом има експорт от някой от тях."
            ],
        }
    columns = set(profile.get("columns") or [])
    template = set(group.template_columns)
    shared_columns = len(columns & template)
    group_meta = set(group.spec.metafields)
    store_meta = _metafield_keys(profile)
    shared_meta = len(group_meta & store_meta)
    title_same = _value(profile, "title_pattern") == group.spec.title
    sku_same = _value(profile, "sku_pattern") == group.spec.sku

    parts = [
        shared_columns / max(1, len(template)),
        shared_meta / max(1, len(group_meta)),
        1.0 if title_same else 0.0,
        1.0 if sku_same else 0.0,
    ]
    total = round(sum(parts) / len(parts), 3)
    reasons = [
        f"{shared_columns} от {len(template)} колони съвпадат"
        + (f", липсват {len(template - columns)}" if template - columns else ""),
        f"{shared_meta} от {len(group_meta)} метаполета съвпадат"
        + (f", нови: {', '.join(sorted(store_meta - group_meta))}" if store_meta - group_meta else ""),
        "заглавието е по същата формула"
        if title_same
        else f"заглавието е различно: {_value(profile, 'title_pattern')}",
        "SKU е по същата формула" if sku_same else f"SKU е различно: {_value(profile, 'sku_pattern')}",
    ]
    return {
        "group": group.key,
        "name": group.spec.name,
        "score": total,
        "recommended": False,
        "comparable": True,
        "reasons": reasons,
    }


def rank(profile: dict, groups: list[Group]) -> list[dict]:
    """Best first; the best comparable group at or above RECOMMEND_AT is recommended, else a new group is."""
    scored = [score(profile, g) for g in groups]
    scored.sort(key=lambda s: (s["score"] is None, -(s["score"] or 0)))
    best = next((s for s in scored if s["comparable"]), None)
    if best and best["score"] >= RECOMMEND_AT:
        best["recommended"] = True
    scored.append(
        {
            "group": None,
            "name": "Нова група",
            "score": None,
            "recommended": not (best and best["recommended"]),
            "comparable": False,
            "reasons": ["Шаблон от този магазин, за магазини с различна структура (/new-group в Claude Code)."],
        }
    )
    return scored
