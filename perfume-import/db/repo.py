"""Persistence for pipeline results."""

from sqlalchemy import create_engine, insert, select
from sqlalchemy.orm import Session

from db.models import Batch, Event, FieldRow, Product, Store, StoreProduct
from pipeline.config import load_group
from pipeline.settings import get_settings
from pipeline.validate import AuditReport

_engine = None


def engine():
    global _engine
    if _engine is None:
        _engine = create_engine(get_settings().sqlalchemy_url, pool_pre_ping=True)
    return _engine


def ensure_store(session: Session, group_key: str, store_key: str) -> Store:
    store = session.get(Store, store_key)
    if store is None:
        cfg = load_group(group_key).store(store_key)
        store = Store(
            key=store_key,
            group_key=group_key,
            label=cfg.label,
            country=cfg.country,
            language=cfg.language,
            currency=cfg.currency,
            shop_domain=None if cfg.shop in (None, "CHANGE_ME") else cfg.shop,
            token_env=cfg.token_env,
        )
        session.add(store)
        session.flush()
    return store


def save_audit(report: AuditReport, author: str | None = None) -> int:
    """Store an audit as a batch (kind 'audit'): one product + store_product per row, every field with provenance."""
    with Session(engine()) as session, session.begin():
        ensure_store(session, report.group, report.store)
        batch = Batch(
            kind="audit",
            name=f"Одит {report.store} · {report.source}",
            group_key=report.group,
            store_key=report.store,
            author=author,
        )
        session.add(batch)
        session.flush()

        products = (
            session.execute(
                insert(Product).returning(Product.id),
                [
                    {"batch_id": batch.id, "ean": _ean(p) or None, "input": {"handle": p.handle, "title": p.title}}
                    for p in report.products
                ],
            )
            .scalars()
            .all()
        )
        store_products = (
            session.execute(
                insert(StoreProduct).returning(StoreProduct.id),
                [{"product_id": pid, "store_key": report.store} for pid in products],
            )
            .scalars()
            .all()
        )
        rows = []
        for sp_id, p in zip(store_products, report.products, strict=True):
            for f in p.fields.values():
                rows.append(
                    {
                        "store_product_id": sp_id,
                        "key": f.key,
                        "value": f.value,
                        "origin": f.origin,
                        "status": f.status,
                        "confidence": f.confidence,
                        "sources": f.sources,
                        "alternatives": f.alternatives,
                        "previous": f.previous,
                        "value_en": f.value_en,
                        "message": f.message,
                        "issues": f.issues,
                    }
                )
        session.execute(insert(FieldRow), rows)
        session.add(Event(actor=author, kind="audit_created", batch_id=batch.id, payload=report.summary()))
        return batch.id


def _ean(p) -> str:
    value = p.fields["ean"].value
    return str(value)[:14] if value else ""


def batch_counts(batch_id: int) -> dict[str, int]:
    with Session(engine()) as session:
        stmt = (
            select(FieldRow.status)
            .join(StoreProduct, StoreProduct.id == FieldRow.store_product_id)
            .join(Product, Product.id == StoreProduct.product_id)
            .where(Product.batch_id == batch_id)
        )
        counts: dict[str, int] = {}
        for status in session.execute(stmt).scalars():
            counts[status] = counts.get(status, 0) + 1
        return counts
