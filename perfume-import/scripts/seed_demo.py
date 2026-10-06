#!/usr/bin/env python
"""A demo batch for building and testing the app (DESIGN.md: real data, never lorem ipsum). No AI, no cost.

Takes products that exist in both group-1 exports (same EAN in PremierParfums GR and Parfemija HR), uses their
real fields as the audit reads them (with the real fixes, warnings and blocked findings), downloads the real main
picture and composes it like a new batch (Phase 3). Saved as a batch named "Демо …" so nobody mistakes it for
researched products.

    python scripts/seed_demo.py                 # 10 products
    python scripts/seed_demo.py --products 40 --audits   # plus both exports as audit batches
"""

import argparse
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import insert  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from db.models import Batch, Event, FieldRow, Product, StoreProduct  # noqa: E402
from db.repo import _field_rows, engine, ensure_store, save_audit, save_media  # noqa: E402
from pipeline.batch import ProductResult, image_composed  # noqa: E402
from pipeline.compose import compose_for_stores  # noqa: E402
from pipeline.config import load_group  # noqa: E402
from pipeline.export import load_export  # noqa: E402
from pipeline.images import check  # noqa: E402
from pipeline.input import InputRow  # noqa: E402
from pipeline.settings import ROOT  # noqa: E402
from pipeline.validate import audit  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"
STORES = {"premierparfums": "premierparfums_export.csv", "parfemija": "parfemija_export.csv"}


def pick(common: list[str], by_store: dict, n: int) -> list[str]:
    """A mix like a real batch: some with blocked findings, some auto-fixed, the rest at random."""
    rng = random.Random(7)

    def has(ean, status):
        return any(f.status == status for s in by_store.values() for f in s[ean].fields.values())

    blocked = [e for e in common if has(e, "blocked")]
    fixed = [e for e in common if has(e, "fixed") and e not in blocked]
    chosen = rng.sample(blocked, min(len(blocked), max(1, n // 4))) + rng.sample(fixed, min(len(fixed), n // 4))
    rest = [e for e in common if e not in chosen]
    chosen += rng.sample(rest, max(0, n - len(chosen)))
    return sorted(chosen, key=lambda e: by_store["premierparfums"][e].title)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--products", type=int, default=10)
    ap.add_argument("--audits", action="store_true", help="запиши и двата експорта като одит")
    args = ap.parse_args()

    group = load_group("group-1")
    reports = {key: audit(load_export(FIXTURES / name), group, key) for key, name in STORES.items()}
    by_store = {
        key: {p.fields["ean"].value: p for p in r.products if p.fields["ean"].value and p.fields["image"].value}
        for key, r in reports.items()
    }
    common = sorted(set.intersection(*(set(s) for s in by_store.values())))
    chosen = pick(common, by_store, args.products)

    with Session(engine()) as session, session.begin():
        for key in STORES:
            ensure_store(session, group.key, key)
        batch = Batch(kind="new", name=f"Демо: {len(chosen)} продукта от експортите GR и HR", group_key=group.key)
        session.add(batch)
        session.flush()
        for ean in chosen:
            gr = by_store["premierparfums"][ean]
            product = Product(batch_id=batch.id, ean=ean, input={"name": gr.title, "ean": ean, "demo": True})
            session.add(product)
            session.flush()
            # The store's current picture is the source; compose it like a new batch would.
            result = ProductResult(row=InputRow(line=0, name=gr.title, ml=None, tester=False, ean=ean, prices={}))
            result.original = check({"url": gr.fields["image"].value, "source": "export"})
            if result.original.ok:
                try:
                    result.composed = compose_for_stores(result.original.data, group, list(STORES))
                except Exception as exc:  # one bad picture must not stop the demo
                    result.compose_error = str(exc)
            pictures = save_media(session, product.id, result)
            for key in STORES:
                fields = by_store[key][ean].fields
                image = fields["image"]
                if result.original.ok:
                    image.status, image.origin = "suggested", "ai_research"
                    image.message = f"Снимка от експорта, {result.original.width}×{result.original.height} px."
                    image.sources = [{"url": result.original.url, "title": "сегашна снимка в магазина"}]
                    image_composed(image, result.composed.get(key), result.compose_error)
                    if key in pictures["stores"]:
                        image.value = f"/api/media/{pictures['stores'][key].id}"
                        image.alternatives = [f"/api/media/{pictures['original'].id}"]
                sp = StoreProduct(product_id=product.id, store_key=key)
                session.add(sp)
                session.flush()
                session.execute(insert(FieldRow), _field_rows(sp.id, fields))
            print(f"  {gr.title}")
        session.add(Event(kind="batch_created", batch_id=batch.id, payload={"demo": True, "eans": chosen}))
        batch_id = batch.id
    print(f"Демо партида {batch_id}: {len(chosen)} продукта.")
    if args.audits:
        for key, report in reports.items():
            print(f"Одит {key}: партида {save_audit(report)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
