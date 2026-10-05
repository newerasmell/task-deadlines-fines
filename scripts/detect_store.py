#!/usr/bin/env python
"""Learn a store profile from its Shopify product export (SPEC §2).

    python scripts/detect_store.py tests/fixtures/parfemija_export.csv --store parfemija \
        --group group-1 --reference tests/fixtures/premierparfums_export.csv --out output/parfemija.json
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.config import load_group  # noqa: E402
from pipeline.detect import detect_profile  # noqa: E402
from pipeline.export import load_export  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("export", help="Shopify product export, .csv or .xlsx")
    ap.add_argument("--store", required=True, help="store key, e.g. parfemija")
    ap.add_argument("--group", help="group whose defaults (vocab fields, store country) to use")
    ap.add_argument("--reference", help="export of another store with the same products (vocab, note pairs)")
    ap.add_argument("--out", help="write the profile JSON here instead of stdout")
    args = ap.parse_args()

    group = load_group(args.group) if args.group else None
    reference = load_export(args.reference) if args.reference else None
    profile = detect_profile(load_export(args.export), args.store, group=group, reference=reference)
    text = json.dumps(profile, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(text, encoding="utf-8")
        print(f"Профилът е записан в {args.out}. За потвърждение: {', '.join(profile['to_confirm']) or 'нищо'}")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
