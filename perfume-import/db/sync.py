"""A store's catalog read live from Shopify, in place of an uploaded CSV export (docs/decisions.md #21).

The products are checked by the store's rules exactly like an export and saved as the store's new catalog
check. What was done here and is not in the store yet (a person's edit, an AI suggestion, a picture or a text
taken from another store) is carried onto the new copy of the same product (same handle), so a sync never
loses work; the older checks of that store are then removed. Fixes the rules make are made again anyway."""

import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from db import newbatch
from db.live import same
from db.models import Batch, Event, FieldRow, Product, StoreProduct
from db.repo import save_audit_in
from pipeline.config import load_group
from pipeline.export import Export
from pipeline.shopify import catalog_rows, store_client
from pipeline.validate import audit as run_audit

# Fields not from the store, the rules or the template: made here and kept over a sync until they are live.
MADE_HERE = ("ai_research", "ai_generated")


class SyncError(Exception):
    """Bulgarian message."""


def _engine():
    from db.repo import engine

    return engine()


def _text(value) -> str:
    return "" if value is None else str(value).strip()


def _group_of(store_key: str) -> str:
    from db.stores import list_stores

    row = next((s for s in list_stores() if s["key"] == store_key), None)
    if row is None:
        raise KeyError(f"Няма магазин {store_key}.")
    if not row["group"] or not row["profile_accepted"]:
        raise SyncError(
            f"{row['label']} още няма шаблон. Качи веднъж каталога му в „Магазини“, за да се научи шаблонът; "
            "после продуктите се изтеглят директно от Shopify."
        )
    return row["group"]


def run(store_key: str, actor: str | None, shop=None, job: dict | None = None) -> dict:
    group_key = _group_of(store_key)
    group = load_group(group_key)
    shop = shop or store_client(group, store_key)

    def progress(n: int) -> None:
        if job is not None:
            job["done"] = n

    columns, rows = catalog_rows(shop, progress)
    if not rows:
        raise SyncError(f"{shop.shop} не върна нито един продукт; каталогът тук остава както е.")
    if job is not None:
        job.update(stage="check", stage_label=f"Проверявам {len(rows)} продукта по правилата")
    stamp = datetime.now(UTC).strftime("%Y-%m-%d %H:%M")
    report = run_audit(Export(Path(f"Shopify {stamp}"), columns, rows), group, store_key)

    gids = [r["Shopify ID"] for r in rows]  # in the order of report.products
    # One transaction, so a restart in the middle (a deploy) leaves the store as it was. The store's catalog is
    # one batch kept for good: its products are updated in place (same ids, so open pages and links keep
    # working), new ones are added, ones the store no longer has are removed (decisions #42).
    with Session(_engine()) as session, session.begin():
        batches = list(
            session.execute(
                select(Batch.id).where(Batch.kind == "audit", Batch.store_key == store_key).order_by(Batch.id)
            ).scalars()
        )
        if not batches:
            batch_id = save_audit_in(session, report, actor)
            for handle, (_, sp_id) in _by_handle(session, batch_id).items():
                gid = next((g for p, g in zip(report.products, gids, strict=True) if p.handle == handle), None)
                session.execute(update(StoreProduct).where(StoreProduct.id == sp_id).values(shopify_product_id=gid))
            carried = added = removed = 0
        else:
            batch_id = batches[-1]
            carried, added, removed = _update_in_place(session, batch_id, store_key, report, gids)
            if batches[:-1]:  # reads kept by an older version of the app
                session.execute(delete(Batch).where(Batch.id.in_(batches[:-1])))
        session.add(
            Event(
                actor=actor,
                kind="catalog_synced",
                batch_id=batch_id,
                payload={
                    "store": store_key,
                    "products": len(rows),
                    "carried": carried,
                    "added": added,
                    "removed": removed,
                },
            )
        )
    return {"store": store_key, "batch_id": batch_id, "products": len(rows), "carried": carried}


def _apply(session: Session, sp_id: int, rows: dict[str, FieldRow], fresh: dict) -> int:
    """The store's current fields onto one product. What a person or the AI set here stays: if the store shows
    something else it waits to go live again (the store's value as `previous`), if the store shows the same it is
    kept as decided. Everything else takes the store's value and its checks. Returns how many were kept waiting."""
    from db.repo import _field_rows

    waiting = 0
    for key, f in fresh.items():
        target = rows.get(key)
        if target is None:
            session.add(FieldRow(**_field_rows(sp_id, {key: f})[0]))
            continue
        live_value = f.previous if f.previous is not None else f.value  # an automatic fix keeps the store's
        if target.decided_by is not None or target.origin in MADE_HERE:
            if not same(target.value, live_value):
                waiting += 1
            target.previous = live_value if live_value is not None else ""
            continue
        target.value, target.origin, target.status = f.value, f.origin, f.status
        target.confidence, target.sources, target.alternatives = f.confidence, f.sources, f.alternatives
        target.previous, target.value_en, target.message, target.issues = f.previous, f.value_en, f.message, f.issues
    return waiting


def _update_in_place(session: Session, batch_id: int, store_key: str, report, gids: list[str]) -> tuple[int, int, int]:
    from db.repo import _ean, _field_rows

    existing = session.execute(
        select(Product, StoreProduct)
        .join(StoreProduct, StoreProduct.product_id == Product.id)
        .where(Product.batch_id == batch_id)
    ).all()
    by_gid = {sp.shopify_product_id: (p, sp) for p, sp in existing if sp.shopify_product_id}
    by_handle = {p.input.get("handle"): (p, sp) for p, sp in existing}
    fields: dict[int, dict[str, FieldRow]] = {}
    for row in session.execute(
        select(FieldRow).where(FieldRow.store_product_id.in_([sp.id for _, sp in existing]))
    ).scalars():
        fields.setdefault(row.store_product_id, {})[row.key] = row
    matched: set[int] = set()
    carried = added = 0
    for fresh, gid in zip(report.products, gids, strict=True):
        found = by_gid.get(gid) or by_handle.get(fresh.handle)
        if found is not None and found[0].id not in matched:
            product, sp = found
            matched.add(product.id)
            carried += _apply(session, sp.id, fields.get(sp.id, {}), fresh.fields)
            product.input = {**(product.input or {}), "handle": fresh.handle, "title": fresh.title}
            product.ean = _ean(fresh) or product.ean
            sp.shopify_product_id = gid
            continue
        product = Product(
            batch_id=batch_id, ean=_ean(fresh) or None, input={"handle": fresh.handle, "title": fresh.title}
        )
        session.add(product)
        session.flush()
        sp = StoreProduct(product_id=product.id, store_key=store_key, shopify_product_id=gid)
        session.add(sp)
        session.flush()
        for values in _field_rows(sp.id, fresh.fields):
            session.add(FieldRow(**values))
        added += 1
    gone = [p.id for p, _ in existing if p.id not in matched]
    if gone:  # no longer in the store (deleted or archived there)
        session.execute(delete(Product).where(Product.id.in_(gone)))
    return carried, added, len(gone)


def _by_handle(session: Session, batch_id: int) -> dict[str, tuple[int, int]]:
    """handle -> (product id, store product id) of one catalog check."""
    return {
        p.input.get("handle"): (p.id, sp_id)
        for p, sp_id in session.execute(
            select(Product, StoreProduct.id)
            .join(StoreProduct, StoreProduct.product_id == Product.id)
            .where(Product.batch_id == batch_id)
        ).all()
    }


# ---- background jobs ------------------------------------------------------------------------------------


def start(store_keys: list[str], actor: str | None, shops: dict | None = None) -> str:
    if not store_keys:
        raise SyncError("Няма свързан магазин с шаблон за изтегляне.")
    with newbatch._lock:
        newbatch.busy(sync=True)
        job_id = uuid.uuid4().hex[:12]
        newbatch._jobs[job_id] = {
            "id": job_id,
            "kind": "sync",
            "running": True,
            "stage": "fetch",
            "stage_label": "Изтеглям продуктите от Shopify",
            "done": 0,
            "total": 0,
            "error": None,
            "batch_id": None,
            "result": None,
            "cost_usd": None,
            "store": None,
            "started_at": time.time(),
            "finished_at": None,
        }
    job = newbatch._jobs[job_id]

    def work():
        results, errors = [], []
        for key in store_keys:
            job.update(store=key, stage="fetch", stage_label="Изтеглям продуктите от Shopify", done=0)
            try:
                results.append(run(key, actor, (shops or {}).get(key), job))
            except Exception as exc:  # one store failing does not stop the others
                errors.append(f"{key}: {exc}")
        job.update(
            result={"stores": results, "errors": errors},
            error="; ".join(errors) if errors and not results else None,
            running=False,
            finished_at=time.time(),
        )

    threading.Thread(target=work, daemon=True, name=f"sync-{job_id}").start()
    return job_id


def ready_stores() -> list[str]:
    """Stores that can be read: a learned template and Shopify access."""
    from db.stores import list_stores

    return [s["key"] for s in list_stores() if s["profile_accepted"] and s["group"] and not s["access"]]


def auto_loop(every_hours: float, first_after: float = 600) -> None:
    """Reads every ready store every few hours, skipping a round while another job runs."""

    def loop():
        time.sleep(first_after)
        while True:
            try:
                if not newbatch.running():  # an automatic round waits for an AI job: memory is shared
                    start(ready_stores(), "автоматично")
            except Exception:  # nothing ready, or a job started meanwhile: try next round
                pass
            time.sleep(every_hours * 3600)

    threading.Thread(target=loop, daemon=True, name="sync-auto").start()


def refresh_product(product_id: int, actor: str | None, shop=None) -> dict:
    """„Провери в магазина“: one product of a store's catalog read again from Shopify. The store's values become
    the reference (`previous`); what a person or the AI set here and the store does not show yet stays, so it
    shows again as a change to send; everything else takes the store's value. Returns db.live.changes()."""
    from db import live
    from db.review import _product_rows
    from pipeline.shopify import product_row

    with Session(_engine()) as session:
        product = session.get(Product, product_id)
        if product is None:
            raise KeyError(f"Няма продукт {product_id}.")
        batch = session.get(Batch, product.batch_id)
        if batch.kind != "audit":
            raise SyncError("Това е нов продукт, подготвен тук; в магазина го качваш с „Качи в магазините“.")
        sp = session.execute(select(StoreProduct).where(StoreProduct.product_id == product_id)).scalars().first()
        fields = _product_rows(session, product_id)[sp.store_key]
        handle = fields.get("handle")
        handle_text = str((handle.previous if handle is not None and handle.previous else None) or "")
        handle_text = handle_text or str(handle.value if handle is not None else "")
        group = load_group(batch.group_key)
        store_key, shopify_id = sp.store_key, sp.shopify_product_id
    shop = shop or store_client(group, store_key)
    found = product_row(shop, shopify_id, handle_text)
    if found is None:
        raise SyncError("Продуктът не е намерен в магазина (изтрит или с друг handle).")
    columns, row = found
    fresh = run_audit(Export(Path("Shopify"), columns, [row]), group, store_key).products[0].fields

    with Session(_engine()) as session, session.begin():
        sp = session.get(
            StoreProduct,
            session.execute(select(StoreProduct.id).where(StoreProduct.product_id == product_id)).scalar_one(),
        )
        rows = {r.key: r for r in session.execute(select(FieldRow).where(FieldRow.store_product_id == sp.id)).scalars()}
        _apply(session, sp.id, rows, fresh)
        sp.shopify_product_id = row.get("Shopify ID") or sp.shopify_product_id
        sp.upload_status, sp.upload_message = None, None
        session.add(Event(actor=actor, kind="product_refreshed", batch_id=batch.id, store_product_id=sp.id, payload={}))
    return live.changes(product_id)
