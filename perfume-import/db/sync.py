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
from db.models import Batch, Event, FieldRow, Media, Product, StoreProduct
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

    ids = {r["Handle"]: r["Shopify ID"] for r in rows}
    # One transaction: the new read, what is carried onto it and the removal of the older reads happen
    # together, so a restart in the middle (a deploy) leaves the store as it was.
    with Session(_engine()) as session, session.begin():
        older = list(
            session.execute(
                select(Batch.id).where(Batch.kind == "audit", Batch.store_key == store_key).order_by(Batch.id)
            ).scalars()
        )
        batch_id = save_audit_in(session, report, actor)
        new = _by_handle(session, batch_id)
        for handle, (_, sp_id) in new.items():
            if handle in ids:
                session.execute(
                    update(StoreProduct).where(StoreProduct.id == sp_id).values(shopify_product_id=ids[handle])
                )
        carried = _carry_over(session, older[-1], new) if older else 0
        if older:
            session.execute(delete(Batch).where(Batch.id.in_(older)))
        session.add(
            Event(
                actor=actor,
                kind="catalog_synced",
                batch_id=batch_id,
                payload={"store": store_key, "products": len(rows), "carried": carried},
            )
        )
    return {"store": store_key, "batch_id": batch_id, "products": len(rows), "carried": carried}


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


def _carry_over(session: Session, old_batch: int, new: dict[str, tuple[int, int]]) -> int:
    """Copy what was made here onto the same product of the new check; the store's value becomes `previous`,
    so the product shows the change as waiting for the store. Pictures move with the product."""
    old = _by_handle(session, old_batch)
    pairs = {old_sp: new[h] for h, (_, old_sp) in old.items() if h in new}
    if not pairs:
        return 0
    for h, (old_product, _) in old.items():
        if h in new:
            session.execute(update(Media).where(Media.product_id == old_product).values(product_id=new[h][0]))
    made = session.execute(
        select(FieldRow).where(
            FieldRow.store_product_id.in_(list(pairs)),
            (FieldRow.decided_by.is_not(None)) | (FieldRow.origin.in_(MADE_HERE)),
        )
    ).scalars()
    by_new_sp: dict[int, list[FieldRow]] = {}
    for row in made:
        by_new_sp.setdefault(pairs[row.store_product_id][1], []).append(row)
    if not by_new_sp:
        return 0
    targets = {
        (r.store_product_id, r.key): r
        for r in session.execute(select(FieldRow).where(FieldRow.store_product_id.in_(list(by_new_sp)))).scalars()
    }
    carried = 0
    for sp_id, rows in by_new_sp.items():
        for row in rows:
            target = targets.get((sp_id, row.key))
            if target is None or _text(target.value) == _text(row.value):
                continue  # live already, or a field the store no longer has
            live = target.value
            for attr in ("value", "origin", "status", "confidence", "sources", "alternatives", "value_en"):
                setattr(target, attr, getattr(row, attr))
            for attr in ("message", "issues", "decided_by", "decided_at"):
                setattr(target, attr, getattr(row, attr))
            target.previous = live if live is not None else ""
            carried += 1
    return carried


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
                start(ready_stores(), "автоматично")  # refused while another read runs
            except Exception:  # nothing ready, or a job started meanwhile: try next round
                pass
            time.sleep(every_hours * 3600)

    threading.Thread(target=loop, daemon=True, name="sync-auto").start()
