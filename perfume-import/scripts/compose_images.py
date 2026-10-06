#!/usr/bin/env python
"""Compose the finished pictures of a saved batch again (e.g. after learn_layout.py changed the layout) and make
a contact sheet: original | finished picture, one row per product. No AI, no cost.

    python scripts/compose_images.py --batch 12
    python scripts/compose_images.py --batch 12 --sheet-only     # only the sheet, nothing is changed
"""

import argparse
import sys
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from db.repo import batch_pictures, replace_composed  # noqa: E402
from pipeline import media  # noqa: E402
from pipeline.compose import compose_for_stores  # noqa: E402
from pipeline.config import load_group  # noqa: E402
from pipeline.settings import ROOT  # noqa: E402

TILE = 360
FONTS = ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf"]


def font(size: int):
    for path in FONTS:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def contact_sheet(rows: list[tuple[str, list[bytes], str]], out: Path) -> Path:
    """rows: (title, pictures, note)."""
    columns = max(len(p) for _, p, _ in rows)
    sheet = Image.new("RGB", (columns * (TILE + 10) + 10, len(rows) * (TILE + 50) + 10), "#E6E6E6")
    draw, text = ImageDraw.Draw(sheet), font(14)
    for r, (title, pictures, note) in enumerate(rows):
        y = 10 + r * (TILE + 50)
        draw.text((10, y), f"{title}  {note}"[:160], fill="black", font=text)
        for c, data in enumerate(pictures):
            im = Image.open(BytesIO(data)).convert("RGBA")
            im.thumbnail((TILE, TILE))
            tile = Image.new("RGBA", (TILE, TILE), "white")
            tile.alpha_composite(im, ((TILE - im.width) // 2, (TILE - im.height) // 2))
            sheet.paste(tile.convert("RGB"), (10 + c * (TILE + 10), y + 30))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--batch", type=int, required=True)
    ap.add_argument("--sheet-only", action="store_true", help="само контролен лист, без промени в базата")
    ap.add_argument("--actor", default="compose_images.py")
    args = ap.parse_args()

    products = batch_pictures(args.batch)
    rows, done = [], 0
    for p in products:
        original = p["original"]
        if original is None:
            print(f"  {p['name']}: няма записан оригинал, пропускам.")
            continue
        data = media.resolve(original.path).read_bytes()
        group = load_group(p["group"])
        composed = compose_for_stores(data, group, p["stores"])
        if not args.sheet_only:
            replace_composed(p["product_id"], original, composed, group.spec.rules.image_min_height, args.actor)
            done += 1
        unique = list({c.layout: c for c in composed.values()}.values())
        warnings = "; ".join(w for c in unique for w in c.warnings)
        rows.append((p["name"], [data] + [c.data for c in unique], warnings))
        print(f"  {p['name']}: {', '.join(f'{c.layout} {c.bottle[0]}×{c.bottle[1]}' for c in unique)} {warnings}")
    if not rows:
        print("Няма снимки за сглобяване.")
        return 1
    out = contact_sheet(rows, ROOT / "output" / f"compose-batch-{args.batch}.png")
    print(f"{'Пресглобени' if done else 'Без промени'}: {done} продукта. Контролен лист: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
