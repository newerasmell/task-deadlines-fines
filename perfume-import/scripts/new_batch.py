#!/usr/bin/env python
"""Create a batch of new perfumes for a store group (SPEC §1): research, texts, fields per store, validation.

    python scripts/new_batch.py input/sample-5.csv --group group-1 --stores premierparfums,parfemija --estimate
    python scripts/new_batch.py input/sample-5.csv --group group-1 --stores premierparfums,parfemija

Needs ANTHROPIC_API_KEY in the environment (never in the repo). --estimate checks the file and shows the
expected cost without calling the API.
"""

import argparse
import json
import os
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.config import load_group  # noqa: E402
from pipeline.input import InputError, read_input  # noqa: E402

LABELS = {
    "ok": "ok",
    "fixed": "поправени",
    "suggested": "за преглед",
    "warning": "предупреждения",
    "blocked": "блокирани",
}
# Rough, unmeasured per-call costs (USD) for --estimate; replaced by real numbers after the first run.
EST_RESEARCH, EST_MASTER, EST_LANGUAGE = 0.30, 0.03, 0.02


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="CSV по input/products_template.csv")
    ap.add_argument("--group", required=True)
    ap.add_argument("--stores", help="магазини, разделени със запетая (по подразбиране всички в групата)")
    ap.add_argument("--limit", type=int, help="само първите N продукта")
    ap.add_argument("--name", help="име на партидата (по подразбиране дата + файл)")
    ap.add_argument("--estimate", action="store_true", help="само проверка на входа и очаквана цена, без AI")
    ap.add_argument("--refresh", action="store_true", help="проучи отново, дори ако EAN вече е проучван")
    ap.add_argument("--no-save", action="store_true", help="не записвай в базата")
    args = ap.parse_args()

    group = load_group(args.group)
    stores = args.stores.split(",") if args.stores else list(group.stores)
    try:
        rows = read_input(args.input, group, stores)
    except (InputError, KeyError) as exc:
        print(f"Файлът не може да се използва: {exc}")
        return 2
    rows = rows[: args.limit] if args.limit else rows
    for row in rows:
        for problem in row.problems:
            print(f"  {row.label}: {problem}")

    languages = sorted({group.store(s).language for s in stores} - {"en"})
    per_product = EST_RESEARCH + EST_MASTER + EST_LANGUAGE * len(languages)
    print(
        f"{len(rows)} продукта × {len(stores)} магазина, езици: {', '.join(languages) or 'en'}. "
        f"Очаквана цена ≈ ${per_product * len(rows):.2f} (≈ ${per_product:.2f} на продукт, груба оценка)."
    )
    if args.estimate:
        return 0
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Липсва ANTHROPIC_API_KEY. Добави го като променлива на средата (не в репото) и пусни отново.")
        return 2

    from pipeline.ai import default_client
    from pipeline.batch import run_batch

    saved = lambda ean: None  # noqa: E731
    if not args.no_save:
        from db.repo import find_research

        saved = find_research
    name = args.name or f"{date.today().isoformat()} · {Path(args.input).stem}"
    result = run_batch(default_client(), rows, group, stores, name, saved_research=saved, refresh=args.refresh)

    summary = result.summary()
    out = Path("output") / f"batch-{Path(args.input).stem}.json"
    out.parent.mkdir(exist_ok=True)
    detail = [
        {
            "input": p.row.name,
            "cost_usd": p.cost_usd,
            "reused_research": p.reused_research,
            "stores": {s: {k: f.to_dict() for k, f in fields.items()} for s, fields in p.stores.items()},
        }
        for p in result.products
    ]
    out.write_text(json.dumps({"summary": summary, "products": detail}, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Партида „{name}“: {len(rows)} продукта.")
    for store, counts in summary["stores"].items():
        line = " · ".join(f"{n} {LABELS[s]}" for s, n in counts["products"].items() if n)
        print(f"  {group.store(store).label}: {line}")
    print(f"Цена: ${summary['cost_usd']:.2f} общо, ${summary['cost_per_product_usd']:.2f} на продукт.")
    print(f"Детайли по полета: {out}")
    if not args.no_save:
        from db.repo import save_batch

        print(f"Записана като партида #{save_batch(result)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
