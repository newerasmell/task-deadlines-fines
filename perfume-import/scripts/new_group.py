#!/usr/bin/env python
"""Create a group's structure from its stores' exports (SPEC §2b, `/new-group`). No AI, no cost.

    python scripts/new_group.py --group group-2 --name "Група 2" \
        scentivio=exports/scentivio.csv luxaromi=exports/luxaromi.csv

Every export is profiled (detect_store); the one with most products is the base. Writes into config/groups/<g>/:
group.yaml (title, handle and SKU formulas, metafields, Google fields, fixed columns, description shape,
tester sentences, price rules), vocab.yaml (canonical values and the variants that fold into them),
import_template.csv (the export's columns) and description.md (a starting guide to adapt). stores.yaml is kept
when it exists. Nothing is overwritten without --force. What the stores disagree on and every inferred item
below 90% match is listed to confirm.
"""

import argparse
import csv
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.config import config_dir  # noqa: E402
from pipeline.detect import detect_profile  # noqa: E402
from pipeline.export import load_export  # noqa: E402

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
        "rules": {"compare_at_ratio": value(profile, "compare_at_ratio", [1.2, 2.5]), "image_min_height": 1000},
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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--group", required=True, help="ключ на групата, напр. group-2")
    ap.add_argument("--name", required=True, help="име, напр. „Група 2“")
    ap.add_argument("exports", nargs="+", help="магазин=експорт.csv (един до три)")
    ap.add_argument("--force", action="store_true", help="презапиши съществуващ group.yaml / vocab.yaml")
    ap.add_argument("--config", help="папка config (по подразбиране тази на проекта)")
    args = ap.parse_args()

    pairs = [e.split("=", 1) for e in args.exports]
    if any(len(p) != 2 for p in pairs):
        print("Подай експортите като магазин=път, напр. scentivio=exports/scentivio.csv")
        return 2
    exports = {store: load_export(path) for store, path in pairs}
    profiles = {store: detect_profile(export, store) for store, export in exports.items()}
    base = max(profiles, key=lambda s: profiles[s]["products"])
    profile = profiles[base]

    folder = Path(args.config or config_dir()) / "groups" / args.group
    folder.mkdir(parents=True, exist_ok=True)
    if (folder / "group.yaml").exists() and not args.force:
        print(f"{folder / 'group.yaml'} вече има. Пусни с --force, за да го замениш.")
        return 2

    spec, unknown = group_yaml(args.name, profile, profiles)
    sources = ", ".join(f"{s} ({p['source']})" for s, p in profiles.items())
    header = (
        f"# {args.name}: derived by scripts/new_group.py from {sources}.\n"
        "# Confirm the inferred values below before the first batch.\n"
    )
    (folder / "group.yaml").write_text(header + yaml.safe_dump(spec, allow_unicode=True, sort_keys=False), "utf-8")
    vocab = vocab_yaml(profile)
    (folder / "vocab.yaml").write_text(
        "# Canonical values and the variants auto-fixed to them, from the exports. Confirm the canonical list.\n"
        + yaml.safe_dump(vocab, allow_unicode=True, sort_keys=False),
        "utf-8",
    )
    with (folder / "import_template.csv").open("w", encoding="utf-8", newline="") as fh:
        csv.writer(fh).writerow(exports[base].columns)
    guide = folder / "description.md"
    if not guide.exists():
        source = config_dir() / "groups" / "group-1" / "description.md"
        text = source.read_text("utf-8") if source.exists() else ""
        guide.write_text(
            f"<!-- Started from group-1's guide by scripts/new_group.py: adapt it to {args.name}. -->\n" + text, "utf-8"
        )
    stores = folder / "stores.yaml"
    if not stores.exists():
        lines = ["defaults:", "  status: draft", "stores:"]
        for store, p in profiles.items():
            markets = value(p, "markets", [])
            country = markets[0]["country"] if markets else "XX"
            lines.append(
                f'  {store}: {{label: "{store}", country: {country}, language: {value(p, "content_language")}, '
                f"currency: {value(p, 'currency')}, shop: CHANGE_ME, token_env: SHOPIFY_TOKEN_{store.upper()}}}"
            )
        stores.write_text("\n".join(lines) + "\n", "utf-8")

    print(f"Групата {args.group} е създадена в {folder} (основа: {base}, {profile['products']} продукта).")
    to_confirm = sorted(profile.get("to_confirm", []))
    if to_confirm:
        print("Провери (под 90% съвпадение): " + ", ".join(to_confirm))
    if unknown:
        print("Метаполета, които системата не попълва сама: " + ", ".join(unknown))
    for line in disagreements(base, profiles):
        print("Магазините се различават: " + line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
