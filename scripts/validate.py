#!/usr/bin/env python
"""Validate products against the group rules (SPEC §7). Audit mode runs on a store's Shopify export.

python scripts/validate.py --audit tests/fixtures/parfemija_export.csv --group group-1 --store parfemija
"""

import argparse
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.config import load_group  # noqa: E402
from pipeline.export import load_export  # noqa: E402
from pipeline.validate import audit  # noqa: E402

LABELS = {
    "ok": "ok",
    "fixed": "поправени",
    "suggested": "за преглед",
    "warning": "предупреждения",
    "blocked": "блокирани",
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--audit", required=True, metavar="EXPORT", help="Shopify product export, .csv or .xlsx")
    ap.add_argument("--group", required=True)
    ap.add_argument("--store", required=True)
    ap.add_argument("--out", default="output", help="folder for audit-<store>.json and .csv")
    ap.add_argument("--save", action="store_true", help="also save as an audit batch in the database")
    args = ap.parse_args()

    report = audit(load_export(args.audit), load_group(args.group), args.store)
    summary = report.summary()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / f"audit-{args.store}.json").write_text(
        json.dumps({"summary": summary, "findings": report.findings()}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    with (out / f"audit-{args.store}.csv").open("w", encoding="utf-8", newline="") as fh:
        rows = report.findings()
        writer = csv.DictWriter(fh, fieldnames=list(rows[0]) if rows else ["handle"])
        writer.writeheader()
        writer.writerows(rows)

    print(f"Одит на {args.store} ({summary['products']} продукта, {summary['source']})")
    print("Продукти: " + " · ".join(f"{n} {LABELS[s]}" for s, n in summary["products_by_status"].items()))
    print("Полета:   " + " · ".join(f"{n} {LABELS[s]}" for s, n in summary["fields_by_status"].items()))
    for rule, info in summary["rules"].items():
        print(f"  {info['status']:<9} {info['count']:>5}  {rule}")
    print(f"Детайли: {out / f'audit-{args.store}.json'} и .csv")

    if args.save:
        from db.repo import save_audit

        batch_id = save_audit(report)
        print(f"Записан като одит партида #{batch_id}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
