#!/usr/bin/env python
"""Create a batch of new perfumes for a store group (SPEC §1): research, texts, fields per store, validation.

    python scripts/new_batch.py input/sample-5.csv --group group-1 --stores premierparfums,parfemija --estimate
    python scripts/new_batch.py input/sample-5.csv --group group-1 --stores premierparfums,parfemija

Needs ANTHROPIC_API_KEY in the environment (never in the repo). --estimate checks the file and shows the
expected cost without calling the API.
"""

import argparse
import json
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.ai import api_key  # noqa: E402
from pipeline.config import load_group  # noqa: E402
from pipeline.input import InputError, read_input  # noqa: E402

LABELS = {
    "ok": "ok",
    "fixed": "поправени",
    "suggested": "за преглед",
    "warning": "предупреждения",
    "blocked": "блокирани",
}
# Per-step costs (USD) for --estimate when the database has no measured run yet (Sonnet 5.5, 3 searches,
# texts through the Batches API). After a run, the averages from events (kind ai_usage) are used instead.
DEFAULT_COSTS = {"research": 0.06, "description_en": 0.003, "language": 0.003}


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
    ap.add_argument("--no-batch", action="store_true", help="текстовете без Batch API: по-бързо, 2× по-скъпо")
    ap.add_argument("--max-cost", type=float, default=0.10, help="лимит в USD на продукт (по подразбиране 0.10)")
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
    costs, source = DEFAULT_COSTS, "оценка без измерване"
    if not args.no_save:
        try:
            from db.repo import measured_costs

            measured = measured_costs()
            if measured:
                costs, source = {**DEFAULT_COSTS, **measured}, "средно от последните измерени продукти"
        except Exception:  # no database: fall back to the defaults
            pass
    factor = 2 if args.no_batch else 1
    per_product = costs["research"] + factor * (costs["description_en"] + costs["language"] * len(languages))
    print(
        f"{len(rows)} продукта × {len(stores)} магазина, езици: {', '.join(languages) or 'en'}. "
        f"Очаквана цена ≈ ${per_product * len(rows):.2f} (≈ ${per_product:.3f} на продукт, {source}; "
        f"лимит ${args.max_cost:.2f})."
    )
    if args.estimate:
        return 0
    if not api_key():
        print("Липсва ключ: задай PERFUME_ANTHROPIC_API_KEY (или ANTHROPIC_API_KEY) в средата, не в репото.")
        return 2

    from pipeline.ai import default_client
    from pipeline.batch import run_batch

    saved = lambda ean: None  # noqa: E731
    if not args.no_save:
        from db.repo import find_research

        saved = find_research
    name = args.name or f"{date.today().isoformat()} · {Path(args.input).stem}"
    result = run_batch(
        default_client(),
        rows,
        group,
        stores,
        name,
        saved_research=saved,
        refresh=args.refresh,
        batch_texts=not args.no_batch,
        max_cost=args.max_cost,
    )

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
    print(f"Цена: ${summary['cost_usd']:.2f} общо, ${summary['cost_per_product_usd']:.3f} на продукт.")
    for over in summary["over_budget"]:
        steps = ", ".join(f"{k} ${v:.3f}" for k, v in over["steps"].items())
        print(f"  Над лимита ${args.max_cost:.2f}: {over['input']} ${over['cost_usd']:.3f} ({steps})")
    print(f"Детайли по полета: {out}")
    if not args.no_save:
        from db.repo import save_batch

        print(f"Записана като партида #{save_batch(result)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
