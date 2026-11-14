"""A group's structure (group.yaml, vocab.yaml, import_template.csv, description.md, image layout) derived from its
stores' products (SPEC §2b). Used by scripts/new_group.py and by the app (db.groups). No AI, no cost."""

import csv
import shutil
from pathlib import Path

import yaml

from pipeline.config import config_dir
from pipeline.detect import detect_profile
from pipeline.export import Export

KNOWN_METAFIELDS = {
    "fragrance_family": {"source": "vocab.fragrance_family"},
    "gender": {"source": "vocab.gender"},
    "top_note": {"source": "notes.top", "localized": True},
    "middle_note": {"source": "notes.middle", "localized": True},
    "base_note": {"source": "notes.base", "localized": True},
    "ingredients": {"source": "research.ingredients", "suffix_localized": True},
    "product_milliliters": "{ml} ml",
    "product_type": "{concentration_short}",
}
SKIP_METAFIELDS = {"sklad"}  # decisions #8: the EAN is read from the SKU


def value(profile: dict, key: str, default=None):
    return (profile["items"].get(key) or {}).get("value", default)


def _ratio(profile: dict) -> list[float]:
    """The compare-at range the stores use; the usual one when they show none (no compare-at prices)."""
    ratio = value(profile, "compare_at_ratio") or []
    return [float(r) for r in ratio] if len(ratio) == 2 and None not in ratio else [1.2, 2.5]


def group_yaml(name: str, profile: dict, profiles: dict[str, dict]) -> dict:
    meta = [m for m in value(profile, "metafields", []) if m["namespace"] == "custom"]
    metafields, unknown = {}, []
    for m in meta:
        if m["key"] in SKIP_METAFIELDS:
            continue
        if m["key"] in KNOWN_METAFIELDS:
            metafields[m["key"]] = KNOWN_METAFIELDS[m["key"]]
        else:
            unknown.append(m["key"])
    fixed_items = profile["items"].get("fixed_columns") or {}
    fixed = {k: v["value"] for k, v in fixed_items.items() if not k.startswith("Google Shopping")}
    for k, v in list(fixed.items()):
        if isinstance(v, str) and v.lower() in ("true", "false"):
            fixed[k] = v.lower() == "true"
        elif isinstance(v, str) and v.isdigit():
            fixed[k] = int(v)
    google = {}
    if gender := value(profile, "google_gender"):
        google["gender"] = gender
    for column, key in (
        ("Google Shopping / Condition", "condition"),
        ("Google Shopping / Google Product Category", "product_category"),
    ):
        if column in fixed_items:
            v = fixed_items[column]["value"]
            google[key] = int(v) if str(v).isdigit() else v
    lo, hi = value(profile, "description_length", [300, 600])
    tester = {}
    for p in profiles.values():
        language = value(p, "content_language")
        sentence = value(p, "tester_sentence")
        if language and sentence:
            tester[language] = sentence
    out = {
        "name": name,
        "title": value(profile, "title_pattern"),
        "handle": value(profile, "handle", "slug(title)"),
        "sku": value(profile, "sku_pattern"),
        "title_language": value(profile, "title_language", "en"),
        "concentration_short": value(profile, "concentration_short", {}),
        "auto_accept_generated": False,
        "metafields": metafields,
        "google": google,
        "fixed": fixed,
        "seo": {"title": "{title}", "description": "generated, max 160 chars, store language"},
        "description": {"guide": "description.md", "length": [int(lo), int(hi)], "html": "single <p>"},
        "tester_sentence": tester,
        "rules": {"compare_at_ratio": _ratio(profile), "image_min_height": 1000},
    }
    return out, unknown


def vocab_yaml(profile: dict) -> dict:
    out = {}
    for field, item in (profile["items"].get("vocab") or {}).items():
        canonical = item.get("canonical") or {c: {} for c in item.get("value", [])}
        values = {c: sorted((info or {}).get("variants", {})) for c, info in canonical.items()}
        for local, info in (item.get("translations") or {}).items():
            if info.get("maps_to") in values:
                values[info["maps_to"]].append(local)
        out[field] = values
    return out


def disagreements(base: str, profiles: dict[str, dict]) -> list[str]:
    out = []
    for key in ("title_pattern", "sku_pattern", "handle"):
        values = {store: value(p, key) for store, p in profiles.items()}
        if len(set(map(str, values.values()))) > 1:
            out.append(f"{key}: " + ", ".join(f"{s} = {v}" for s, v in values.items()) + f" (взето от {base})")
    return out


def write_group(folder: Path, name: str, exports: dict[str, Export]) -> dict:
    """Write the structure into folder from these stores' exports; the store with most products is the base.
    Returns what to confirm: the base, items below 90% match, metafields not filled by the app, disagreements."""
    profiles = {store: detect_profile(export, store) for store, export in exports.items()}
    base = max(profiles, key=lambda s: profiles[s]["products"])
    profile = profiles[base]
    folder.mkdir(parents=True, exist_ok=True)
    spec, unknown = group_yaml(name, profile, profiles)
    sources = ", ".join(f"{s} ({p['source']})" for s, p in profiles.items())
    header = f"# {name}: derived from {sources}.\n# Confirm the inferred values below before the first batch.\n"
    (folder / "group.yaml").write_text(header + yaml.safe_dump(spec, allow_unicode=True, sort_keys=False), "utf-8")
    (folder / "vocab.yaml").write_text(
        "# Canonical values and the variants auto-fixed to them, from the exports. Confirm the canonical list.\n"
        + yaml.safe_dump(vocab_yaml(profile), allow_unicode=True, sort_keys=False),
        "utf-8",
    )
    with (folder / "import_template.csv").open("w", encoding="utf-8", newline="") as fh:
        csv.writer(fh).writerow(exports[base].columns)
    group_1 = config_dir() / "groups" / "group-1"
    guide = folder / "description.md"
    if not guide.exists():
        text = (group_1 / "description.md").read_text("utf-8") if (group_1 / "description.md").exists() else ""
        guide.write_text(f"<!-- Started from group-1's guide: adapt it to {name}. -->\n" + text, "utf-8")
    image = folder / "image"
    if not (image / "layout.yaml").exists() and (group_1 / "image").is_dir():  # a starting layout: white 1080 px
        shutil.copytree(group_1 / "image", image, dirs_exist_ok=True)
    return {
        "base": base,
        "products": profile["products"],
        "to_confirm": sorted(profile.get("to_confirm", [])),
        "unknown_metafields": unknown,
        "disagreements": disagreements(base, profiles),
    }
