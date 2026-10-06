"""More stores for a batch that is already researched (the research is reused, never paid again).

The stores of the batch's group that are not in it yet can be added: each product gets its picture composed
for the new store, its own text (the store's style, or its language's translation) and its fields. Facts a
person already decided for the product (EAN, name, gender…) are carried over to the new stores.
"""

import threading
import time
import uuid
from dataclasses import fields as dataclass_fields

from sqlalchemy import insert, select
from sqlalchemy.orm import Session

from db import newbatch
from db.models import Batch, Event, FieldRow, Media, Product, StoreProduct, StoreProfile
from pipeline import media
from pipeline.ai import api_key
from pipeline.config import load_group
from pipeline.images import Checked
from pipeline.input import InputRow
from pipeline.tiers import TIERS

# Decided facts that hold for the product everywhere; the SKU follows the EAN (review._set_value rebuilds it).
CARRIED = ("vendor", "name", "concentration", "gender", "fragrance_family", "ingredients", "ean")


def _engine():
    from db.repo import engine

    return engine()


def _batch_stores(session: Session, batch_id: int) -> list[str]:
    return list(
        dict.fromkeys(
            session.execute(
                select(StoreProduct.store_key)
                .join(Product, Product.id == StoreProduct.product_id)
                .where(Product.batch_id == batch_id)
                .order_by(StoreProduct.id)
            ).scalars()
        )
    )


def options(batch_id: int) -> dict:
    """The group's stores not in the batch, with whether each has a template and Shopify access, and the
    expected cost (texts only: the research is reused)."""
    from pipeline.shopify import missing_settings

    with Session(_engine()) as session:
        batch = session.get(Batch, batch_id)
        if batch is None or batch.kind != "new":
            raise KeyError(f"Няма нова партида {batch_id}.")
        present = _batch_stores(session, batch_id)
        count = len(session.execute(select(Product.id).where(Product.batch_id == batch_id)).scalars().all())
        templates = set(
            session.execute(select(StoreProfile.store_key).where(StoreProfile.state == "accepted")).scalars()
        )
    group = load_group(batch.group_key)
    text_cost = TIERS["economy"].text_cost
    return {
        "batch_id": batch_id,
        "products": count,
        "present": present,
        "stores": [
            {
                "key": s.key,
                "label": s.label,
                "country": s.country,
                "language": s.language,
                "currency": s.currency,
                "template": s.key in templates,
                "access": missing_settings(s),
            }
            for s in group.stores.values()
            if s.key not in present
        ],
        # Per text for all the batch's products (fast mode: direct calls, twice the Batches price). Adding n
        # stores costs (1 English master + n store texts) × this; the research is not paid again.
        "cost_per_text": round(count * text_cost * 2, 4),
    }


def _items(session: Session, batch_id: int) -> list[tuple[int, InputRow, dict | None, Checked | None]]:
    names = {f.name for f in dataclass_fields(InputRow)}
    out = []
    for product in session.execute(select(Product).where(Product.batch_id == batch_id).order_by(Product.id)).scalars():
        row = InputRow(**{k: v for k, v in (product.input or {}).items() if k in names})
        original = session.execute(
            select(Media)
            .where(Media.product_id == product.id, Media.kind == "original")
            .order_by(Media.id.desc())
            .limit(1)
        ).scalar_one_or_none()
        checked = None
        if original is not None:
            path = media.resolve(original.path)
            if path.is_file():
                checked = Checked(
                    url=original.source_url or "",
                    source=(original.info or {}).get("source", ""),
                    width=original.width or 0,
                    height=original.height or 0,
                    data=path.read_bytes(),
                )
        out.append((product.id, row, product.research, checked))
    return out


def start(batch_id: int, stores: list[str], actor: str | None, fast: bool = True, client=None) -> str:
    """Background job like a new batch (db.newbatch: one at a time, progress, lost on a restart)."""
    if not api_key() and client is None:
        raise newbatch.NewBatchError(
            "Няма ключ за Claude. Добави ANTHROPIC_API_KEY в Render → perfume-import → Environment и опитай отново."
        )
    opts = options(batch_id)
    allowed = {s["key"] for s in opts["stores"]}
    stores = [s for s in dict.fromkeys(stores) if s in allowed]
    if not stores:
        raise newbatch.NewBatchError("Избери поне един магазин, който още не е в партидата.")
    with newbatch._lock:
        if any(j["running"] for j in newbatch._jobs.values()):
            raise newbatch.NewBatchError("Вече върви задача; изчакай да свърши.")
        job_id = uuid.uuid4().hex[:12]
        newbatch._jobs[job_id] = {
            "id": job_id,
            "kind": "extend",
            "running": True,
            "stage": "images",
            "stage_label": newbatch.STAGES["images"],
            "done": 0,
            "total": opts["products"],
            "error": None,
            "batch_id": None,
            "target_batch_id": batch_id,
            "cost_usd": None,
            "fast": fast,
            "started_at": time.time(),
            "finished_at": None,
        }
    job = newbatch._jobs[job_id]

    def progress(stage: str, done: int, total: int) -> None:
        job.update({"stage": stage, "stage_label": newbatch.STAGES.get(stage, stage), "done": done, "total": total})

    def work() -> None:
        from db.stores import accepted_profiles
        from pipeline.ai import default_client
        from pipeline.batch import extend_batch

        try:
            with Session(_engine()) as session:
                batch = session.get(Batch, batch_id)
                group_key = batch.group_key
                items = _items(session, batch_id)
            group = load_group(group_key)
            results = extend_batch(
                client or default_client(),
                [(row, raw, original) for _, row, raw, original in items],
                group,
                stores,
                profiles=accepted_profiles(stores),
                batch_texts=False if fast else None,
                progress=progress,
            )
            progress("saving", 0, 1)
            cost = save(
                batch_id, group_key, stores, [(pid, r) for (pid, *_), r in zip(items, results, strict=True)], actor
            )
            job.update({"batch_id": batch_id, "cost_usd": cost})
        except Exception as exc:  # shown in the app; save() is one transaction
            job["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            job.update({"running": False, "finished_at": time.time()})

    threading.Thread(target=work, daemon=True, name=f"new-batch-{job_id}").start()
    return job_id


def save(batch_id: int, group_key: str, stores: list[str], results: list, actor: str | None) -> float:
    """New store products with their fields and finished pictures; decided facts carried over. Returns the cost."""
    from db.repo import _field_rows, ensure_store, with_media
    from db.review import _product_rows, _set_value

    total = 0.0
    with Session(_engine()) as session, session.begin():
        batch = session.get(Batch, batch_id)
        for store in stores:
            ensure_store(session, group_key, store)
        for product_id, p in results:
            if p is None:
                continue
            total += p.cost_usd
            pictures = _pictures(session, product_id, p)
            decided = _decided(session, product_id)
            for store in stores:
                sp = StoreProduct(product_id=product_id, store_key=store)
                session.add(sp)
                session.flush()
                session.execute(insert(FieldRow), _field_rows(sp.id, with_media(p.stores[store], store, pictures)))
            session.flush()
            rows = _product_rows(session, product_id)
            for key, (value, who, source_store) in decided.items():
                for store in stores:
                    if key in rows.get(store, {}) and rows[store][key].value != value:
                        _set_value(batch, store, rows[store], key, value, "edit", who or actor)
                        rows[store][key].message = f"Решено от {who or 'екипа'} (пренесено от {source_store})."
            session.add(
                Event(
                    actor=actor,
                    kind="ai_usage",
                    batch_id=batch_id,
                    payload={
                        "name": p.row.name,
                        "reused_research": True,
                        "added_stores": stores,
                        "steps": p.usage,
                        "cost_usd": p.cost_usd,
                    },
                )
            )
        session.add(Event(actor=actor, kind="stores_added", batch_id=batch_id, payload={"stores": stores}))
    return round(total, 4)


def _decided(session: Session, product_id: int) -> dict[str, tuple]:
    """Facts a person decided for this product in an existing store: key -> (value, who, store)."""
    out = {}
    rows = session.execute(
        select(FieldRow, StoreProduct.store_key)
        .join(StoreProduct, StoreProduct.id == FieldRow.store_product_id)
        .where(StoreProduct.product_id == product_id, FieldRow.key.in_(CARRIED), FieldRow.decided_by.is_not(None))
        .order_by(FieldRow.decided_at)
    ).all()
    for row, store in rows:
        out[row.key] = (row.value, row.decided_by, store)
    return out


def _pictures(session: Session, product_id: int, p) -> dict:
    """The stored original, and a finished picture per new store (one per layout, reusing an existing one)."""
    original = session.execute(
        select(Media).where(Media.product_id == product_id, Media.kind == "original").order_by(Media.id.desc()).limit(1)
    ).scalar_one_or_none()
    out: dict = {"original": original, "stores": {}}
    existing = {
        m.layout: m
        for m in session.execute(
            select(Media).where(Media.product_id == product_id, Media.kind == "composed")
        ).scalars()
    }
    for store, c in p.composed.items():
        row = existing.get(c.layout)
        if row is None:
            stored = media.write(c.data)
            row = Media(
                product_id=product_id,
                kind="composed",
                layout=c.layout,
                source_url=original.source_url if original else None,
                path=stored.path,
                content_type=stored.content_type,
                width=stored.width,
                height=stored.height,
                bytes=stored.bytes,
                sha256=stored.sha256,
                info={"bottle": list(c.bottle), "scaled": c.scaled, "warnings": c.warnings},
            )
            session.add(row)
            session.flush()
            existing[c.layout] = row
        out["stores"][store] = row
    return out
