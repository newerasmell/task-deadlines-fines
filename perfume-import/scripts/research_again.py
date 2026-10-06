#!/usr/bin/env python
"""Research one product again with a chosen tier and save it as a new batch (docs/decisions.md #9).

    python scripts/research_again.py --ean 3614270581656 --tier deep

Takes the product's input row and stores from its newest saved batch. Nothing in the old batch is changed,
so decisions already made there stay; the new batch can be reviewed and compared in the app.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.ai import api_key  # noqa: E402
from pipeline.input import InputRow  # noqa: E402
from pipeline.tiers import TIERS  # noqa: E402

LABELS = {
    "ok": "ok",
    "fixed": "поправени",
    "suggested": "за преглед",
    "warning": "предупреждения",
    "blocked": "блокирани",
}


def row_from_saved(saved: dict, tier: str) -> InputRow:
    data = saved["input"]
    return InputRow(
        line=data.get("line", 0),
        name=data["name"],
        ml=data.get("ml"),
        tester=bool(data.get("tester")),
        ean=data.get("ean", ""),
        prices=data.get("prices", {}),
        notes=data.get("notes", ""),
        tier=tier,
        problems=[],
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ean", required=True)
    ap.add_argument("--tier", default="deep", choices=list(TIERS))
    ap.add_argument("--stores", help="магазини, разделени със запетая (по подразбиране тези от последната партида)")
    args = ap.parse_args()

    from db.repo import latest_product, save_batch

    saved = latest_product(args.ean)
    if saved is None:
        print(f"В базата няма продукт с EAN {args.ean}. Пусни го първо с scripts/new_batch.py.")
        return 2
    stores = args.stores.split(",") if args.stores else saved["stores"]
    tier = TIERS[args.tier]
    print(
        f"{saved['input']['name']} (партида #{saved['batch_id']}) → {tier.label} проучване за {', '.join(stores)}; "
        f"лимит ${tier.max_cost:.2f}."
    )
    if not api_key():
        print("Липсва ключ: задай PERFUME_ANTHROPIC_API_KEY (или ANTHROPIC_API_KEY) в средата, не в репото.")
        return 2

    from pipeline.ai import default_client
    from pipeline.batch import run_batch
    from pipeline.config import load_group

    row = row_from_saved(saved, tier.name)
    name = f"{'Задълбочено' if tier.name == 'deep' else 'Повторно'}: {row.name}"
    result = run_batch(default_client(), [row], load_group(saved["group"]), stores, name, refresh=True)
    summary = result.summary()
    for store, counts in summary["stores"].items():
        print(f"  {store}: " + " · ".join(f"{n} {LABELS[s]}" for s, n in counts["fields"].items() if n) + " полета")
    p = result.products[0]
    steps = ", ".join(f"{k} ${u['cost_usd']:.3f}" for k, u in p.usage.items())
    print(f"Цена: ${p.cost_usd:.3f} ({steps}).")
    print(f"Записана като партида #{save_batch(result)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
