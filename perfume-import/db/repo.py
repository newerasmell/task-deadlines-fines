"""Persistence for pipeline results."""

from sqlalchemy import create_engine, insert, select
from sqlalchemy.orm import Session

from db.models import Batch, Event, FieldRow, Product, Store, StoreProduct, VocabLearned
from pipeline.batch import BatchResult, row_dict
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
        rows = [
            row
            for sp_id, p in zip(store_products, report.products, strict=True)
            for row in _field_rows(sp_id, p.fields)
        ]
        session.execute(insert(FieldRow), rows)
        session.add(Event(actor=author, kind="audit_created", batch_id=batch.id, payload=report.summary()))
        return batch.id


def _field_rows(store_product_id: int, fields: dict) -> list[dict]:
    return [
        {
            "store_product_id": store_product_id,
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
        for f in fields.values()
    ]


def save_batch(result: BatchResult, author: str | None = None) -> int:
    """A new batch: products with their input and research, one store_product per store, every field."""
    with Session(engine()) as session, session.begin():
        for store in result.stores:
            ensure_store(session, result.group, store)
        batch = Batch(kind="new", name=result.name, group_key=result.group, author=author)
        session.add(batch)
        session.flush()
        for p in result.products:
            product = Product(
                batch_id=batch.id,
                ean=(p.row.ean or None) and p.row.ean[:14],
                input=row_dict(p.row),
                research=p.research.raw if p.research and p.research.raw else None,
            )
            session.add(product)
            session.flush()
            for store, fields in p.stores.items():
                sp = StoreProduct(product_id=product.id, store_key=store)
                session.add(sp)
                session.flush()
                session.execute(insert(FieldRow), _field_rows(sp.id, fields))
            session.add(
                Event(
                    actor=author,
                    kind="ai_usage",
                    batch_id=batch.id,
                    payload={
                        "ean": p.row.ean,
                        "name": p.row.name,
                        "reused_research": p.reused_research,
                        "tier": p.tier.name,
                        "steps": p.usage,
                        "cost_usd": p.cost_usd,
                    },
                )
            )
        session.add(Event(actor=author, kind="batch_created", batch_id=batch.id, payload=result.summary()))
        return batch.id


def find_research(ean: str) -> dict | None:
    """The latest successful research for this EAN, so the same product is never paid for twice."""
    with Session(engine()) as session:
        stmt = (
            select(Product.research)
            .where(Product.ean == ean, Product.research.is_not(None))
            .order_by(Product.id.desc())
            .limit(1)
        )
        return session.execute(stmt).scalar_one_or_none()


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


def save_vocab_suggestions(group_key: str, suggestions: dict[str, list[dict]]) -> int:
    """Store AI vocab proposals as suggested; never touch a variant a person already accepted or rejected."""
    saved = 0
    with Session(engine()) as session, session.begin():
        for field_key, items in suggestions.items():
            for item in items:
                if not item["canonical"]:
                    continue
                row = session.execute(
                    select(VocabLearned).where(
                        VocabLearned.group_key == group_key,
                        VocabLearned.field_key == field_key,
                        VocabLearned.variant == item["variant"],
                    )
                ).scalar_one_or_none()
                if row is None:
                    row = VocabLearned(group_key=group_key, field_key=field_key, variant=item["variant"])
                    session.add(row)
                elif row.status != "suggested":
                    continue
                row.canonical, row.source, row.status = item["canonical"], "ai", "suggested"
                row.hits, row.confidence, row.reason = item.get("count", 1), item["confidence"], item["reason"]
                saved += 1
    return saved


def measured_costs(tier: str = "economy", last: int = 50) -> dict[str, float]:
    """Average cost per step over the last products of this tier that were really researched (--estimate).
    Events written before tiers existed count as economy."""
    with Session(engine()) as session:
        rows = session.execute(
            select(Event.payload).where(Event.kind == "ai_usage").order_by(Event.id.desc()).limit(last)
        ).scalars()
        sums: dict[str, list[float]] = {"research": [], "description_en": [], "language": []}
        for payload in rows:
            steps = payload.get("steps", {})
            if payload.get("reused_research") or "research" not in steps:
                continue
            if payload.get("tier", "economy") != tier:
                continue
            sums["research"].append(steps["research"]["cost_usd"])
            if "description_en" in steps:
                sums["description_en"].append(steps["description_en"]["cost_usd"])
            sums["language"] += [u["cost_usd"] for k, u in steps.items() if k.startswith("text_")]
    return {k: sum(v) / len(v) for k, v in sums.items() if v}


def latest_product(ean: str) -> dict | None:
    """The newest saved product with this EAN: its input row and the stores it was built for."""
    with Session(engine()) as session:
        product = session.execute(
            select(Product).where(Product.ean == ean).order_by(Product.id.desc()).limit(1)
        ).scalar_one_or_none()
        if product is None:
            return None
        batch = session.get(Batch, product.batch_id)
        stores = session.execute(
            select(StoreProduct.store_key).where(StoreProduct.product_id == product.id).order_by(StoreProduct.id)
        ).scalars()
        return {"input": dict(product.input), "group": batch.group_key, "stores": list(stores), "batch_id": batch.id}
