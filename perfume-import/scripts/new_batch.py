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
from pipeline.estimate import estimate, usd  # noqa: E402
from pipeline.input import InputError, read_input  # noqa: E402
from pipeline.tiers import TIERS  # noqa: E402

LABELS = {
    "ok": "ok",
    "fixed": "поправени",
    "suggested": "за преглед",
    "warning": "предупреждения",
    "blocked": "блокирани",
}


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
    ap.add_argument("--no-batch", action="store_true", help="евтините текстове без Batch API: по-бързо, 2× по-скъпо")
    ap.add_argument(
        "--max-cost", type=float, help="лимит в USD на продукт за всички (по подразбиране по режим: 0.125 / 0.50)"
    )
    ap.add_argument(
        "--tier", default="economy", choices=list(TIERS), help="режим за партидата (по подразбиране economy)"
    )
    ap.add_argument("--deep", default="", help="EAN-и, разделени със запетая, които да се проучат задълбочено")
    args = ap.parse_args()

    if not args.no_save:
        from db.stores import install

        install()  # stores and Shopify domains set in the app count too
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

    deep_eans = {e.strip() for e in args.deep.split(",") if e.strip()}
    measured = {}
    if not args.no_save:
        try:
            from db.repo import measured_costs

            measured = {name: measured_costs(name) for name in TIERS}
        except Exception:  # no database: the defaults
            pass
    est = estimate(rows, group, stores, args.tier, deep_eans, measured, args.max_cost, args.no_batch)
    print(
        f"{len(rows)} продукта × {len(stores)} магазина, езици: {', '.join(est.languages) or 'en'}. "
        f"Очаквана цена ≈ ${est.total:.2f}."
    )
    for t in est.tiers:
        source = "измерено" if t.measured else "оценка без измерване"
        cap = f"лимит {usd(t.limit)}, таван {usd(t.ceiling)}"
        print(f"  {t.label}: {t.products} × ≈ ${t.per_product:.3f} ({source}; {cap})")
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
    profiles = {}
    if not args.no_save:
        from db.stores import accepted_profiles

        profiles = accepted_profiles(stores)  # each store's own formulas (CLAUDE.md principle 1)
    result = run_batch(
        default_client(),
        rows,
        group,
        stores,
        name,
        saved_research=saved,
        refresh=args.refresh,
        batch_texts=False if args.no_batch else None,
        max_cost=args.max_cost,
        default_tier=args.tier,
        deep_eans=deep_eans,
        profiles=profiles,
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
        print(
            f"  Над лимита {usd(over['limit_usd'])} ({over['tier']}): {over['input']} ${over['cost_usd']:.3f} ({steps})"
        )
    for skip in summary["skipped"]:
        for step, why in skip["steps"].items():
            print(f"  {skip['input']}, {step}: {why}")
    print(f"Детайли по полета: {out}")
    if not args.no_save:
        from db.repo import save_batch

        print(f"Записана като партида #{save_batch(result)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
