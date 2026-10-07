"""Upload a batch to the stores (SPEC §1 step 4, §8.5). Only approved products go, store by store; every
attempt is kept on the store product (status, message, Shopify id) and in the events log, so a retry sends
only what failed and a re-upload updates instead of duplicating.

Runs in a background thread started by the API; one upload per batch at a time.
"""

import threading
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from db.models import Batch, Event, FieldRow, Media, Product, StoreProduct
from db.review import to_field
from pipeline import media
from pipeline.config import load_group
from pipeline.shopify import Shopify, ShopifyError, missing_settings, store_client, upload_product

STATUSES = ("draft", "active")
_jobs: dict[int, dict] = {}
_lock = threading.Lock()


def _engine():
    from db.repo import engine

    return engine()


def ready(session: Session, sp: StoreProduct) -> str | None:
    """None when the store product may go to Shopify, else why not (CLAUDE.md #8)."""
    if sp.approved_at is None:
        return "Продуктът не е одобрен."
    pending = (
        session.execute(
            select(FieldRow.key).where(
                FieldRow.store_product_id == sp.id, FieldRow.status.in_(("blocked", "suggested"))
            )
        )
        .scalars()
        .all()
    )
    if pending:
        return f"Има нерешени полета: {', '.join(pending)}."
    return None


def plan(
    batch_id: int, stores: list[str] | None = None, only_failed: bool = False, product_ids: list[int] | None = None
) -> list[tuple[int, str]]:
    """(store_product_id, store) to send, approved and ready, in product order."""
    with Session(_engine()) as session:
        rows = (
            session.execute(
                select(StoreProduct)
                .join(Product, Product.id == StoreProduct.product_id)
                .where(Product.batch_id == batch_id)
                .order_by(Product.id, StoreProduct.id)
            )
            .scalars()
            .all()
        )
        out = []
        for sp in rows:
            if stores and sp.store_key not in stores:
                continue
            if product_ids and sp.product_id not in product_ids:
                continue
            if only_failed and sp.upload_status != "failed":
                continue
            if ready(session, sp) is None:
                out.append((sp.id, sp.store_key))
        return out


def _image(fields: dict) -> tuple[bytes, str, str] | str | None:
    """The finished picture from MEDIA_DIR, or the source URL when it was never composed."""
    f = fields.get("image")
    value = str(f.value) if f and f.value else ""
    if value.startswith("/api/media/"):
        with Session(_engine()) as session:
            row = session.get(Media, int(value.rsplit("/", 1)[1]))
        if row is None:
            raise ShopifyError("Снимката липсва в базата; сглоби я наново (scripts/compose_images.py).")
        path = media.resolve(row.path)
        if not path.is_file():
            raise ShopifyError("Файлът на снимката липсва на диска (MEDIA_DIR); сглоби я наново.")
        return path.read_bytes(), Path(row.path).name, row.content_type
    return value or None


def upload_one(session: Session, sp: StoreProduct, shop: Shopify, status: str, actor: str | None) -> None:
    rows = session.execute(select(FieldRow).where(FieldRow.store_product_id == sp.id)).scalars().all()
    fields = {r.key: to_field(r) for r in rows}
    now = datetime.now(UTC)
    sp.upload_attempted_at = now
    notes = []
    price = fields.get("price")
    if status == "active" and not (price and str(price.value or "").strip()):
        status = "draft"  # decisions #16: never active without a price; the price is set in Shopify
        notes.append("Без цена: качен като чернова.")
    try:
        result = upload_product(shop, fields, status, sp.shopify_product_id, _image(fields))
    except ShopifyError as exc:
        sp.upload_status, sp.upload_message = "failed", str(exc)
        payload = {"error": str(exc)}
    else:
        verb = "създаден" if result.action == "created" else "обновен"
        kind = "чернова" if result.status == "DRAFT" else "активен"
        sp.shopify_product_id, sp.uploaded_at = result.product_id, now
        sp.upload_status = "uploaded"
        sp.upload_message = " ".join(
            [f"{verb}, {kind}, снимка качена." if fields.get("image") else f"{verb}, {kind}.", *notes, *result.notes]
        )
        payload = {"product_id": result.product_id, "action": result.action, "status": result.status}
    batch_id = session.get(Product, sp.product_id).batch_id
    session.add(
        Event(
            actor=actor,
            kind=f"upload_{sp.upload_status}",
            batch_id=batch_id,
            store_product_id=sp.id,
            payload={**payload, "store": sp.store_key},
        )
    )


def run(
    batch_id: int,
    status: str = "draft",
    stores: list[str] | None = None,
    only_failed: bool = False,
    actor: str | None = None,
    client: Callable[[object, str], Shopify] | None = None,
    product_ids: list[int] | None = None,
) -> dict:
    """Upload synchronously (the API runs this in a thread). Returns counts per store."""
    if status not in STATUSES:
        raise ValueError(f"Непознат статус „{status}“.")
    with Session(_engine()) as session:
        batch = session.get(Batch, batch_id)
        if batch is None:
            raise KeyError(f"Няма партида {batch_id}.")
        if batch.kind != "new":
            raise ValueError("Качват се само партиди с нови продукти; одитът се поправя с CSV (Фаза 6).")
        group = load_group(batch.group_key)
    client = client or store_client
    todo = plan(batch_id, stores, only_failed, product_ids)
    job = _jobs.setdefault(batch_id, {})
    job.update({"total": len(todo), "done": 0, "running": True, "error": None})
    counts: dict[str, dict[str, int]] = {}
    shops: dict[str, Shopify | ShopifyError] = {}
    try:
        for sp_id, store in todo:
            if store not in shops:
                try:
                    shops[store] = client(group, store)
                except ShopifyError as exc:
                    shops[store] = exc
            with Session(_engine()) as session, session.begin():
                sp = session.get(StoreProduct, sp_id)
                shop = shops[store]
                if isinstance(shop, ShopifyError):
                    sp.upload_status, sp.upload_message = "failed", str(shop)
                    sp.upload_attempted_at = datetime.now(UTC)
                else:
                    upload_one(session, sp, shop, status, actor)
                c = counts.setdefault(store, {"uploaded": 0, "failed": 0})
                c[sp.upload_status] += 1
            job["done"] += 1
        with Session(_engine()) as session, session.begin():
            batch = session.get(Batch, batch_id)
            batch.publish_status = "uploaded" if not any(c["failed"] for c in counts.values()) and todo else "partial"
            session.add(
                Event(
                    actor=actor, kind="batch_uploaded", batch_id=batch_id, payload={"status": status, "counts": counts}
                )
            )
    finally:
        job["running"] = False
    return counts


def start(batch_id: int, **kwargs) -> bool:
    """Run in a background thread; False if an upload of this batch is already running."""
    with _lock:
        if _jobs.get(batch_id, {}).get("running"):
            return False
        _jobs[batch_id] = {"running": True, "total": 0, "done": 0, "error": None}

    def work():
        try:
            run(batch_id, **kwargs)
        except Exception as exc:  # shown in the app; the per-product results are already saved
            _jobs[batch_id].update({"running": False, "error": str(exc)})

    threading.Thread(target=work, daemon=True, name=f"upload-{batch_id}").start()
    return True


def state(batch_id: int) -> dict:
    """What the Upload screen shows: per store, every product with its approval and last attempt."""
    with Session(_engine()) as session:
        batch = session.get(Batch, batch_id)
        if batch is None:
            raise KeyError(f"Няма партида {batch_id}.")
        group = load_group(batch.group_key)
        rows = session.execute(
            select(StoreProduct, Product)
            .join(Product, Product.id == StoreProduct.product_id)
            .where(Product.batch_id == batch_id)
            .order_by(Product.id, StoreProduct.id)
        ).all()
        titles = dict(
            session.execute(
                select(FieldRow.store_product_id, FieldRow.value).where(
                    FieldRow.key == "title", FieldRow.store_product_id.in_([sp.id for sp, _ in rows])
                )
            ).all()
        )
        stores: dict[str, dict] = {}
        for sp, product in rows:
            store = group.stores.get(sp.store_key)
            entry = stores.setdefault(
                sp.store_key,
                {
                    "key": sp.store_key,
                    "label": store.label if store else sp.store_key,
                    "language": store.language if store else None,
                    "country": store.country if store else None,
                    "configured": _configured(group, sp.store_key),
                    "items": [],
                },
            )
            entry["items"].append(
                {
                    "store_product_id": sp.id,
                    "product_id": product.id,
                    "title": titles.get(sp.id) or product.input.get("name"),
                    "blocker": ready(session, sp),
                    "upload_status": sp.upload_status,
                    "upload_message": sp.upload_message,
                    "attempted_at": sp.upload_attempted_at.isoformat() if sp.upload_attempted_at else None,
                    "shopify_url": _admin_url(store.shop if store else None, sp.shopify_product_id),
                }
            )
        job = _jobs.get(batch_id, {})
        return {
            "batch_id": batch_id,
            "kind": batch.kind,
            "publish_status": batch.publish_status,
            "running": bool(job.get("running")),
            "done": job.get("done", 0),
            "total": job.get("total", 0),
            "error": job.get("error"),
            "stores": list(stores.values()),
        }


def _configured(group, store_key: str) -> str | None:
    """None when the store is set up, else what is missing (no call to Shopify)."""
    return missing_settings(group.store(store_key))


def _admin_url(shop: str | None, product_id: str | None) -> str | None:
    if not shop or shop == "CHANGE_ME" or not product_id:
        return None
    return f"https://{shop}/admin/products/{product_id.rsplit('/', 1)[-1]}"
