#!/usr/bin/env python
"""Measure the main-image layout from a group's current catalog pictures (SPEC §6) and write layout.yaml.

    python scripts/learn_layout.py --group group-1 \
        premierparfums=tests/fixtures/premierparfums_export.csv parfemija=tests/fixtures/parfemija_export.csv

Downloads up to --sample pictures per store (Image Src), measures background and where the bottle sits, and
writes config/groups/<group>/image/layout.yaml. A store whose pictures clearly differ gets its own override.
"""

import argparse
import random
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline import images  # noqa: E402
from pipeline.config import load_group  # noqa: E402
from pipeline.export import load_export  # noqa: E402
from pipeline.layout import learn  # noqa: E402


def sample_pictures(export_path: str, n: int, seed: int) -> list[bytes]:
    urls = [p["Image Src"] for p in load_export(export_path).products if p.get("Image Src")]
    random.Random(seed).shuffle(urls)
    out = []
    for url in urls:
        if len(out) >= n:
            break
        try:
            out.append(images.fetch(url))
        except images.FetchError as exc:
            print(f"  пропусната {url[:80]}: {exc}")
    return out


def differs(a: dict, b: dict) -> bool:
    pa, pb = a["product"], b["product"]
    return (
        a["background"] != b["background"]
        or abs(pa["max_height"] - pb["max_height"]) > 0.05
        or pa["anchor"] != pb["anchor"]
        or a["canvas"] != b["canvas"]
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--group", required=True)
    ap.add_argument("exports", nargs="+", metavar="STORE=EXPORT")
    ap.add_argument("--sample", type=int, default=40, help="снимки на магазин (по подразбиране 40)")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    group = load_group(args.group)
    per_store, everything = {}, []
    for pair in args.exports:
        store, path = pair.split("=", 1)
        group.store(store)
        pictures = sample_pictures(path, args.sample, args.seed)
        per_store[store] = learn(pictures)
        everything += pictures
        lay = per_store[store]
        p = lay["product"]
        print(
            f"{store}: {len(pictures)} снимки, платно {lay['canvas']}, фон {lay['background']},"
            f" шише {p['max_height']:.0%} от височината, {p['anchor']}"
        )
    layout = learn(everything)
    overrides = {s: lay for s, lay in per_store.items() if differs(lay, layout)}
    if overrides:
        layout["stores"] = {
            s: {k: lay[k] for k in ("canvas", "background", "format", "product")} for s, lay in overrides.items()
        }
    target = group.path / "image" / "layout.yaml"
    target.parent.mkdir(parents=True, exist_ok=True)
    header = (
        "# Main image layout, measured from the stores' current pictures by scripts/learn_layout.py.\n"
        "# Shares are of the canvas. The bottle is scaled DOWN to fit max_height x max_width, never up.\n"
    )
    target.write_text(header + yaml.safe_dump(layout, sort_keys=False, allow_unicode=True), encoding="utf-8")
    print(f"Записано: {target}" + (f" (собствен шаблон за {', '.join(overrides)})" if overrides else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
