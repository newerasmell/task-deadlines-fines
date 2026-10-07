"""Catalog audit fixes written live into the store: for each audited product, only the fields that an automatic
fix or a person changed (value ≠ the export's value) are sent, to the existing Shopify product found by its
handle and checked by its SKU. Nothing else of the product is touched."""

import threading
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from db.models import Batch, Event, FieldRow, Product, StoreProduct
from pipeline.config import load_group
from pipeline.shopify import ShopifyError, live_product, store_client, update_live

LABELS = {
    "title": "Заглавие",
    "body_html": "Описание",
    "vendor": "Марка",
    "seo_title": "SEO заглавие",
    "seo_description": "SEO описание",
    "handle": "Handle",
    "price": "Цена",
    "compare_at": "Зачеркната",
    "sku": "SKU",
    "gender": "Пол",
    "fragrance_family": "Семейство",
    "top_note": "Горни нотки",
    "middle_note": "Средни нотки",
    "base_note": "Базови нотки",
    "ingredients": "Съставки",
    "product_milliliters": "Обем",
    "product_type": "Тип",
}
_jobs: dict[int, dict] = {}
_lock = threading.Lock()


class LiveError(Exception):
    """Bulgarian message."""


def _engine():
    from db.repo import engine

    return engine()


def _text(value) -> str:
    return "" if value is None else str(value)


def _changes(rows: list[FieldRow]) -> list[FieldRow]:
    """Fields whose value differs from the export, not blocked, and not the derived EAN."""
    return [
        r
        for r in rows
        if r.previous is not None
        and r.key in LABELS
        and r.status != "blocked"
        and _text(r.value).strip() != _text(r.previous).strip()
    ]


def changes(product_id: int) -> dict:
    with Session(_engine()) as session:
        product = session.get(Product, product_id)
        if product is None:
            raise KeyError(f"Няма продукт {product_id}.")
        sp = session.execute(select(StoreProduct).where(StoreProduct.product_id == product_id)).scalars().first()
        rows = session.execute(select(FieldRow).where(FieldRow.store_product_id == sp.id)).scalars().all()
        blocked = [r.key for r in rows if r.status == "blocked"]
        return {
            "product_id": product_id,
            "store": sp.store_key,
            "changes": [
                {"key": r.key, "label": LABELS[r.key], "before": r.previous, "after": r.value, "status": r.status}
                for r in _changes(rows)
            ],
            "blocked": blocked,
            "live_status": sp.upload_status,
            "live_message": sp.upload_message,
        }


def push(product_id: int, actor: str | None, shop=None) -> dict:
    """Write this product's fixes into its store now. Returns the new state (changes())."""
    with Session(_engine()) as session, session.begin():
        product = session.get(Product, product_id)
        if product is None:
            raise KeyError(f"Няма продукт {product_id}.")
        batch = session.get(Batch, product.batch_id)
        if batch.kind != "audit":
            raise LiveError("Това е за одит на каталог; новите продукти се публикуват от „Цени и магазини“.")
        sp = session.execute(select(StoreProduct).where(StoreProduct.product_id == product_id)).scalars().first()
        rows = {r.key: r for r in session.execute(select(FieldRow).where(FieldRow.store_product_id == sp.id)).scalars()}
        todo = _changes(list(rows.values()))
        if not todo:
            raise LiveError("Няма поправки за качване в този продукт.")
        sp.upload_attempted_at = datetime.now(UTC)
        handle = rows.get("handle")
        sku = rows.get("sku")
        try:
            client = shop or store_client(load_group(batch.group_key), sp.store_key)
            found = live_product(client, _text(handle.previous or handle.value) if handle else "")
            if found is None:
                raise ShopifyError("Продуктът не е намерен в магазина по handle (изтрит или преименуван?).")
            known = {_text(sku.previous), _text(sku.value)} if sku else set()
            live_sku = _text((found.get("variant") or {}).get("sku"))
            if sku and live_sku and live_sku not in known:
                raise ShopifyError(
                    f"В магазина този handle е с SKU {live_sku}, а не {sku.previous}: не е същият продукт."
                )
            notes = update_live(client, found, {r.key: r.value for r in todo})
        except ShopifyError as exc:
            sp.upload_status, sp.upload_message = "failed", str(exc)
        else:
            sp.upload_status = "uploaded"
            sp.shopify_product_id, sp.uploaded_at = found["id"], datetime.now(UTC)
            sp.upload_message = " ".join([f"Обновени в магазина: {', '.join(LABELS[r.key] for r in todo)}.", *notes])
        session.add(
            Event(
                actor=actor,
                kind=f"live_{sp.upload_status}",
                batch_id=batch.id,
                store_product_id=sp.id,
                payload={"fields": [r.key for r in todo], "message": sp.upload_message},
            )
        )
    return changes(product_id)


def pending(batch_id: int) -> list[int]:
    """Products of an audit with fixes not yet written live (or that failed)."""
    with Session(_engine()) as session:
        out = []
        for product in session.execute(
            select(Product).where(Product.batch_id == batch_id).order_by(Product.id)
        ).scalars():
            sp = session.execute(select(StoreProduct).where(StoreProduct.product_id == product.id)).scalars().first()
            if sp is None or sp.upload_status == "uploaded":
                continue
            rows = session.execute(select(FieldRow).where(FieldRow.store_product_id == sp.id)).scalars().all()
            if _changes(list(rows)):
                out.append(product.id)
        return out


def start_batch(batch_id: int, actor: str | None, shop=None) -> dict:
    """Every product of the audit with fixes, in the background (one run per audit at a time)."""
    todo = pending(batch_id)
    with _lock:
        if _jobs.get(batch_id, {}).get("running"):
            raise LiveError("Вече се обновява този одит.")
        _jobs[batch_id] = {"running": True, "total": len(todo), "done": 0, "uploaded": 0, "failed": 0, "error": None}
    job = _jobs[batch_id]

    def work():
        try:
            for product_id in todo:
                try:
                    state = push(product_id, actor, shop)
                    job["uploaded" if state["live_status"] == "uploaded" else "failed"] += 1
                except LiveError:
                    pass
                job["done"] += 1
        except Exception as exc:
            job["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            job["running"] = False

    threading.Thread(target=work, daemon=True, name=f"live-{batch_id}").start()
    return dict(job)


def batch_state(batch_id: int) -> dict:
    return {**_jobs.get(batch_id, {"running": False}), "pending": len(pending(batch_id))}
