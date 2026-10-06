"""Review in the app (SPEC §8): read a batch, decide fields, approve products.

Every decision is a field change with provenance (who, when, previous value) and an event. A human edit is
validated with the same rules as the pipeline (pipeline/validate.py), together with the fields whose checks
depend on it (price <-> compare-at, EAN <-> SKU). Facts shared by the stores (brand, EAN, family...) change in
every store of the product at once. Any change withdraws the product's approval.
"""

import copy
from collections import Counter
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from db.models import Batch, Event, FieldRow, Media, Product, Store, StoreProduct
from pipeline.build import google_gender
from pipeline.config import load_group
from pipeline.fields import SEVERITY, Field
from pipeline.titles import render
from pipeline.validate import CONTROLLED, Context, validate_product

# Facts researched once per product: a decision applies to every store.
SHARED = ("vendor", "name", "concentration", "gender", "fragrance_family", "ingredients", "ean", "sku", "image")
# Checks that read two fields: an edit of one revalidates the other.
RELATED = ({"price", "compare_at"}, {"ean", "sku"}, {"title", "product_milliliters"})
# Findings that come from research or input, not from validation; revalidation never clears them.
KEPT_RULES = ("ean_mismatch", "research_mismatch", "input", "input_ml", "title_parts")
PENDING = ("suggested", "blocked")


class ReviewError(Exception):
    """A decision that is not allowed; the message says why in Bulgarian."""


def now() -> datetime:
    return datetime.now(UTC)


# ---- reading -----------------------------------------------------------------------------------------


def to_field(row: FieldRow) -> Field:
    return Field(
        key=row.key,
        value=row.value,
        origin=row.origin,
        status=row.status,
        confidence=row.confidence,
        sources=list(row.sources or []),
        alternatives=list(row.alternatives or []),
        previous=row.previous,
        value_en=row.value_en,
        message=row.message,
        rule=(row.issues or [{}])[-1].get("rule") if row.issues else None,
        issues=list(row.issues or []),
        decided_by=row.decided_by,
        decided_at=row.decided_at.isoformat() if row.decided_at else None,
    )


def field_json(row: FieldRow) -> dict:
    return {
        "id": row.id,
        "key": row.key,
        "value": row.value,
        "origin": row.origin,
        "status": row.status,
        "confidence": row.confidence,
        "sources": row.sources or [],
        "alternatives": row.alternatives or [],
        "previous": row.previous,
        "value_en": row.value_en,
        "message": row.message,
        "issues": row.issues or [],
        "decided_by": row.decided_by,
        "decided_at": row.decided_at.isoformat() if row.decided_at else None,
    }


def product_state(statuses: list[str]) -> str:
    """ready: nothing waits on a person; review: suggestions to decide; blocked: something must be fixed."""
    if "blocked" in statuses:
        return "blocked"
    if "suggested" in statuses:
        return "review"
    return "ready"


def list_batches() -> list[dict]:
    with Session(_engine()) as session:
        batches = session.execute(select(Batch).order_by(Batch.id.desc())).scalars().all()
        rows = session.execute(
            select(
                Product.batch_id,
                Product.id,
                StoreProduct.store_key,
                StoreProduct.approved_at,
                FieldRow.status,
                func.count(),
                func.min(StoreProduct.id),
            )
            .join(StoreProduct, StoreProduct.product_id == Product.id)
            .join(FieldRow, FieldRow.store_product_id == StoreProduct.id)
            .group_by(Product.batch_id, Product.id, StoreProduct.store_key, StoreProduct.approved_at, FieldRow.status)
            .order_by(func.min(StoreProduct.id))
        ).all()
        stores = {s.key: s for s in session.execute(select(Store)).scalars()}
    per_product: dict[int, dict[int, list[str]]] = {}
    store_keys: dict[int, list[str]] = {}
    approved: dict[int, dict[int, bool]] = {}
    for batch_id, product_id, store_key, approved_at, status, count, _ in rows:
        per_product.setdefault(batch_id, {}).setdefault(product_id, []).extend([status] * count)
        keys = store_keys.setdefault(batch_id, [])
        if store_key not in keys:
            keys.append(store_key)
        approved.setdefault(batch_id, {}).setdefault(product_id, True)
        approved[batch_id][product_id] &= approved_at is not None
    out = []
    for b in batches:
        products = per_product.get(b.id, {})
        states = Counter(product_state(s) for s in products.values())
        out.append(
            {
                "id": b.id,
                "kind": b.kind,
                "name": b.name,
                "group": b.group_key,
                "created_at": b.created_at.isoformat(),
                "author": b.author,
                "publish_status": b.publish_status,
                "stores": [_store_json(stores.get(k), k) for k in store_keys.get(b.id, [])],
                "products": len(products),
                "ready": states.get("ready", 0),
                "review": states.get("review", 0),
                "blocked": states.get("blocked", 0),
                "approved": sum(approved.get(b.id, {}).values()),
                "fixed": sum(s.count("fixed") for s in products.values()),
            }
        )
    return out


def _store_json(store: Store | None, key: str) -> dict:
    if store is None:
        return {"key": key, "label": key, "country": None, "language": None, "currency": None}
    return {
        "key": store.key,
        "label": store.label,
        "country": store.country,
        "language": store.language,
        "currency": store.currency,
    }


def get_batch(batch_id: int) -> dict:
    with Session(_engine()) as session:
        batch = session.get(Batch, batch_id)
        if batch is None:
            raise KeyError(f"Няма партида {batch_id}.")
        products = (
            session.execute(select(Product).where(Product.batch_id == batch_id).order_by(Product.id)).scalars().all()
        )
        ids = [p.id for p in products]
        sps = (
            session.execute(select(StoreProduct).where(StoreProduct.product_id.in_(ids)).order_by(StoreProduct.id))
            .scalars()
            .all()
        )
        fields = (
            session.execute(
                select(FieldRow).where(FieldRow.store_product_id.in_([sp.id for sp in sps])).order_by(FieldRow.id)
            )
            .scalars()
            .all()
        )
        media = session.execute(select(Media).where(Media.product_id.in_(ids)).order_by(Media.id)).scalars().all()
        store_rows = {s.key: s for s in session.execute(select(Store)).scalars()}

        by_sp: dict[int, list[FieldRow]] = {}
        for f in fields:
            by_sp.setdefault(f.store_product_id, []).append(f)
        by_product: dict[int, list[StoreProduct]] = {}
        store_order: list[str] = []
        for sp in sps:
            by_product.setdefault(sp.product_id, []).append(sp)
            if sp.store_key not in store_order:
                store_order.append(sp.store_key)
        pictures: dict[int, list[Media]] = {}
        for m in media:
            pictures.setdefault(m.product_id, []).append(m)

        out_products = [_product_dict(p, by_product.get(p.id, []), by_sp, pictures.get(p.id, [])) for p in products]
        return {
            "id": batch.id,
            "kind": batch.kind,
            "name": batch.name,
            "group": batch.group_key,
            "created_at": batch.created_at.isoformat(),
            "author": batch.author,
            "stores": [_store_json(store_rows.get(k), k) for k in store_order],
            "products": out_products,
        }


def _product_dict(p: Product, sps: list[StoreProduct], by_sp: dict[int, list[FieldRow]], media: list) -> dict:
    stores, statuses = {}, []
    for sp in sps:
        rows = by_sp.get(sp.id, [])
        statuses += [r.status for r in rows]
        stores[sp.store_key] = {
            "store_product_id": sp.id,
            "approved_by": sp.approved_by,
            "approved_at": sp.approved_at.isoformat() if sp.approved_at else None,
            "status": max((r.status for r in rows), key=SEVERITY.__getitem__, default="ok"),
            "fields": {r.key: field_json(r) for r in rows},
        }
    first = next(iter(stores.values()), {"fields": {}})["fields"]
    return {
        "id": p.id,
        "ean": p.ean,
        "input": p.input,
        "title": (first.get("title") or {}).get("value") or p.input.get("name") or p.input.get("title"),
        "state": product_state(statuses),
        "counts": dict(Counter(statuses)),
        "stores": stores,
        "media": [_media_json(m) for m in media],
    }


def _media_json(m: Media) -> dict:
    return {
        "id": m.id,
        "url": f"/api/media/{m.id}",
        "kind": m.kind,
        "layout": m.layout,
        "source_url": m.source_url,
        "width": m.width,
        "height": m.height,
        "info": m.info or {},
    }


# ---- deciding ----------------------------------------------------------------------------------------


def decide(field_id: int, action: str, actor: str | None, value=None) -> dict:
    """action: accept | edit | pick. Returns the product's fields per store after the change."""
    if action not in ("accept", "edit", "pick"):
        raise ReviewError(f"Непознато действие „{action}“.")
    with Session(_engine()) as session, session.begin():
        row = session.get(FieldRow, field_id)
        if row is None:
            raise KeyError(f"Няма поле {field_id}.")
        sp = session.get(StoreProduct, row.store_product_id)
        product = session.get(Product, sp.product_id)
        batch = session.get(Batch, product.batch_id)
        siblings = _product_rows(session, product.id)
        targets = decision_targets(siblings, sp.store_key, row)

        if action == "accept":
            if row.status == "blocked":
                raise ReviewError("Спряно поле не може просто да се приеме: поправи стойността или избери друга.")
            for _, target in targets:
                _accept(target, actor)
        else:
            if action == "pick" and value not in (row.alternatives or []) + vocab_values(batch.group_key, row.key):
                raise ReviewError("Тази стойност не е сред алтернативите на полето, нито в речника.")
            if value is None or (isinstance(value, str) and not value.strip() and row.key != "compare_at"):
                raise ReviewError("Празна стойност. Въведи стойност или избери от алтернативите.")
            for store_key, _ in targets:
                _set_value(batch, store_key, siblings[store_key], row.key, value, action, actor)

        _withdraw_approval(session, product.id)
        session.add(
            Event(
                actor=actor,
                kind=f"field_{action}",
                batch_id=batch.id,
                store_product_id=sp.id,
                field_key=row.key,
                payload={"value": value, "previous": row.previous, "stores": [k for k, _ in targets]},
            )
        )
        return _product_json(session, product.id)


def vocab_values(group_key: str, key: str) -> list[str]:
    """Canonical values of a controlled field (gender, fragrance family); [] for free fields."""
    return list(load_group(group_key).vocab.get(key, {}))


def decision_targets(siblings: dict, store_key: str, row: FieldRow) -> list[tuple[str, FieldRow]]:
    """A shared fact with the same value in every store is one decision; anything else is this store only."""
    if row.key not in SHARED:
        return [(store_key, row)]
    out = []
    for key, rows in siblings.items():
        other = rows.get(row.key)
        if other is not None and (other.id == row.id or other.value == row.value):
            out.append((key, other))
    return out


def _accept(row: FieldRow, actor: str | None) -> None:
    if row.status == "blocked":
        return
    issues = list(row.issues or [])
    message = f"Прието от {actor or 'екипа'}."
    if row.status in ("suggested", "warning"):
        issues.append({"status": "ok", "rule": "accepted", "message": message})
        row.status, row.message = "ok", message
    row.issues = issues
    row.decided_by, row.decided_at = actor, now()


def _set_value(batch: Batch, store_key: str, rows: dict[str, FieldRow], key: str, value, action, actor):
    group = load_group(batch.group_key)
    ctx = Context(group, group.store(store_key))
    fields = {k: to_field(r) for k, r in rows.items()}
    old = fields[key]
    edited = Field(
        key=key,
        value=value,
        origin="input" if action == "edit" else ("vocab" if key in CONTROLLED else old.origin),
        status="ok",
        sources=old.sources,
        alternatives=[a for a in old.alternatives if a != value] + ([old.value] if old.value else []),
        previous=old.value,
        value_en=old.value_en,  # the English reference still says what the field means
        decided_by=actor,
        decided_at=now().isoformat(),
    )
    fields[key] = edited
    changed = {key}
    # Values built from this one.
    if key == "ean" and group.spec and "{ean}" in group.spec.sku and "sku" in fields:
        sku = render(group.spec.sku, {"ean": value})
        fields["sku"] = _rebuilt(fields["sku"], sku, f"SKU сглобено наново от EAN {value}.", actor)
        changed.add("sku")
    if key == "gender" and "google.gender" in fields:
        fields["google.gender"] = _rebuilt(fields["google.gender"], google_gender(value, group), "Следва пола.", actor)
        changed.add("google.gender")
    # Checks that read this field together with another one.
    for pair in RELATED:
        if key in pair:
            for other in pair - {key}:
                f = fields.get(other)
                if f and not any(i.get("rule") in KEPT_RULES for i in f.issues):
                    fields[other] = _rebuilt(f, f.value, None, None)
                    changed.add(other)
    check = copy.deepcopy(fields)
    validate_product(check, ctx)
    for k in changed:
        _write(rows[k], check[k])


def _rebuilt(f: Field, value, message: str | None, actor: str | None) -> Field:
    out = copy.deepcopy(f)
    if value != f.value:
        out.previous = f.value
    out.value, out.status, out.issues, out.message = value, "ok", [], message
    if actor:
        out.decided_by, out.decided_at = actor, now().isoformat()
    return out


def _write(row: FieldRow, f: Field) -> None:
    row.value, row.origin, row.status = f.value, f.origin, f.status
    row.alternatives, row.previous, row.value_en = f.alternatives, f.previous, f.value_en
    row.message, row.issues = f.message, f.issues
    row.decided_by = f.decided_by
    row.decided_at = datetime.fromisoformat(f.decided_at) if f.decided_at else None


def accept_all(product_id: int, actor: str | None, store_key: str | None = None) -> dict:
    """Every suggestion of the product (or of one store). Blocked fields stay: they need a fix."""
    with Session(_engine()) as session, session.begin():
        product = session.get(Product, product_id)
        if product is None:
            raise KeyError(f"Няма продукт {product_id}.")
        accepted = 0
        for key, rows in _product_rows(session, product_id).items():
            if store_key and key != store_key:
                continue
            for r in rows.values():
                if r.status == "suggested":
                    _accept(r, actor)
                    accepted += 1
        if accepted:
            _withdraw_approval(session, product_id)
            session.add(
                Event(
                    actor=actor,
                    kind="accept_all",
                    batch_id=product.batch_id,
                    payload={"product": product_id, "store": store_key, "accepted": accepted},
                )
            )
        session.flush()
        return _product_json(session, product_id)


def accept_column(batch_id: int, store_key: str, key: str, actor: str | None) -> int:
    """All suggestions of one field in one store of the batch (the app asks for one confirmation)."""
    with Session(_engine()) as session, session.begin():
        rows = (
            session.execute(
                select(FieldRow)
                .join(StoreProduct, StoreProduct.id == FieldRow.store_product_id)
                .join(Product, Product.id == StoreProduct.product_id)
                .where(
                    Product.batch_id == batch_id,
                    StoreProduct.store_key == store_key,
                    FieldRow.key == key,
                    FieldRow.status == "suggested",
                )
            )
            .scalars()
            .all()
        )
        for r in rows:
            _accept(r, actor)
        products = {r.store_product_id for r in rows}
        for sp in products:
            _withdraw_approval(session, session.get(StoreProduct, sp).product_id)
        if rows:
            session.add(
                Event(
                    actor=actor,
                    kind="accept_column",
                    batch_id=batch_id,
                    field_key=key,
                    payload={"store": store_key, "accepted": len(rows)},
                )
            )
        return len(rows)


def approve(product_id: int, actor: str | None) -> dict:
    """CLAUDE.md #8: approved only with no blocked field and no undecided suggestion in any store."""
    with Session(_engine()) as session, session.begin():
        product = session.get(Product, product_id)
        if product is None:
            raise KeyError(f"Няма продукт {product_id}.")
        rows = _product_rows(session, product_id)
        pending = Counter(r.status for store in rows.values() for r in store.values() if r.status in PENDING)
        if pending:
            parts = []
            if pending["blocked"]:
                parts.append(f"{pending['blocked']} спрени")
            if pending["suggested"]:
                parts.append(f"{pending['suggested']} предложения")
            raise ReviewError(f"Продуктът още има {' и '.join(parts)}. Реши ги и одобри отново.")
        when = now()
        for sp in session.execute(select(StoreProduct).where(StoreProduct.product_id == product_id)).scalars():
            sp.approved_by, sp.approved_at = actor, when
        session.add(
            Event(actor=actor, kind="product_approved", batch_id=product.batch_id, payload={"product": product_id})
        )
        session.flush()
        return _product_json(session, product_id)


def _withdraw_approval(session, product_id: int) -> None:
    for sp in session.execute(select(StoreProduct).where(StoreProduct.product_id == product_id)).scalars():
        if sp.approved_at is not None:
            sp.approved_by, sp.approved_at = None, None


def _product_rows(session, product_id: int) -> dict[str, dict[str, FieldRow]]:
    sps = (
        session.execute(select(StoreProduct).where(StoreProduct.product_id == product_id).order_by(StoreProduct.id))
        .scalars()
        .all()
    )
    out: dict[str, dict[str, FieldRow]] = {}
    for sp in sps:
        rows = session.execute(select(FieldRow).where(FieldRow.store_product_id == sp.id)).scalars().all()
        out[sp.store_key] = {r.key: r for r in rows}
    return out


def _product_json(session, product_id: int) -> dict:
    """The same shape as one product in get_batch."""
    session.flush()
    session.expire_all()
    product = session.get(Product, product_id)
    sps = (
        session.execute(select(StoreProduct).where(StoreProduct.product_id == product_id).order_by(StoreProduct.id))
        .scalars()
        .all()
    )
    rows = (
        session.execute(
            select(FieldRow).where(FieldRow.store_product_id.in_([sp.id for sp in sps])).order_by(FieldRow.id)
        )
        .scalars()
        .all()
    )
    by_sp: dict[int, list[FieldRow]] = {}
    for r in rows:
        by_sp.setdefault(r.store_product_id, []).append(r)
    media = session.execute(select(Media).where(Media.product_id == product_id).order_by(Media.id)).scalars().all()
    return _product_dict(product, sps, by_sp, media)


def _engine():
    from db.repo import engine

    return engine()
