"""The product list across every store: one entry per EAN (or per product without one), with what each store
has. A store's copy comes from its latest catalog audit (it is live there) or from a new-products batch
(prepared here, uploaded or not). An audit wins over a batch for the same store: it is what the store shows."""

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from db.live import LABELS, same
from db.models import Batch, FieldRow, Product, StoreProduct

# live: in the store, nothing to send; diff: in the store, changes made here wait to go live;
# ready: prepared here, not in the store yet; bad: something must be fixed first; none: not in that store.
STATES = ("live", "diff", "ready", "bad", "none")
FILTERS = {
    "all": lambda e: True,
    "todo": lambda e: any(s["state"] in ("diff", "ready") for s in e["stores"].values()),
    "bad": lambda e: any(s["state"] == "bad" for s in e["stores"].values()),
    "missing": lambda e: e["missing"] > 0,
    "fixes": lambda e: e["fixes"] > 0,
}


def _engine():
    from db.repo import engine

    return engine()


def _text(value) -> str:
    return "" if value is None else str(value).strip()


_cache: dict = {}


def _version(session: Session) -> tuple:
    """Changes whenever a product, a field or an upload changes: the list is rebuilt only then."""
    return (
        session.execute(select(func.count(Product.id), func.max(Product.id))).one(),
        session.execute(select(func.count(FieldRow.id), func.max(FieldRow.updated_at))).one(),
        session.execute(select(func.max(StoreProduct.upload_attempted_at), func.count(StoreProduct.id))).one(),
    )


def _entries() -> tuple[list[dict], list[str]]:
    with Session(_engine()) as session:
        version = _version(session)
        if _cache.get("version") == version:
            return _cache["value"]
        _cache["value"] = _build(session)
        _cache["version"] = version
        return _cache["value"]


def _build(session: Session) -> tuple[list[dict], list[str]]:
    latest_audit = select(func.max(Batch.id)).where(Batch.kind == "audit").group_by(Batch.store_key)
    rows = session.execute(
        select(Product.id, Product.batch_id, Product.ean, Product.input, Batch.kind, Batch.created_at)
        .join(Batch, Batch.id == Product.batch_id)
        .where((Batch.kind == "new") | Batch.id.in_(latest_audit))
        .order_by(Product.id)
    ).all()
    products = {r.id: r for r in rows}
    sps = session.execute(
        select(StoreProduct.id, StoreProduct.product_id, StoreProduct.store_key, StoreProduct.upload_status)
        .where(StoreProduct.product_id.in_(list(products)))
        .order_by(StoreProduct.id)
    ).all()
    sp_ids = [sp.id for sp in sps]
    blocked = dict(
        session.execute(
            select(FieldRow.store_product_id, func.count())
            .where(FieldRow.store_product_id.in_(sp_ids), FieldRow.status == "blocked")
            .group_by(FieldRow.store_product_id)
        ).all()
    )
    values: dict[int, dict[str, object]] = {}
    for sp_id, key, value in session.execute(
        select(FieldRow.store_product_id, FieldRow.key, FieldRow.value).where(
            FieldRow.store_product_id.in_(sp_ids), FieldRow.key.in_(["title", "ean", "image"])
        )
    ):
        values.setdefault(sp_id, {})[key] = value
    # Only the columns the comparison needs, and only rows that differ at all (db.live._changes decides).
    # A change a person or the AI made waits to go live (diff); a fix the store's rules made by themselves is
    # counted apart, so the list is not all orange after every catalog check.
    changed: set[int] = set()
    fixes: set[int] = set()
    for sp_id, value, previous, origin, decided_by in session.execute(
        select(
            FieldRow.store_product_id, FieldRow.value, FieldRow.previous, FieldRow.origin, FieldRow.decided_by
        ).where(
            FieldRow.store_product_id.in_(sp_ids),
            FieldRow.previous.is_not(None),
            FieldRow.key.in_(list(LABELS)),
            FieldRow.status != "blocked",
            FieldRow.value.is_distinct_from(FieldRow.previous),
        )
    ):
        # previous is JSON null (not SQL NULL) on fields the store had and nothing changed: not a change.
        if previous is not None and not same(value, previous):
            (fixes if origin == "auto_fix" and not decided_by else changed).add(sp_id)

    entries: dict[str, dict] = {}
    order: list[str] = []
    for sp in sps:
        p = products[sp.product_id]
        own = values.get(sp.id, {})
        ean = _text(p.ean) or _text(own.get("ean"))
        title = _text(own.get("title")) or _text(p.input.get("name")) or _text(p.input.get("title"))
        # Without an EAN the same title in two stores is taken as the same product; else it stands alone.
        key = ean or (f"t:{_norm(title)}" if title else f"p{p.id}")
        if not ean and sp.store_key in entries.get(key, {}).get("stores", {}):
            key = f"p{p.id}"
        entry_fix = False
        if p.kind == "audit":
            # A push to the store makes the pushed values the new reference (db.live.push), so what still
            # differs is waiting, whatever the last push did.
            if sp.id in changed:
                state = "diff"
            elif sp.id in fixes and not blocked.get(sp.id):
                state = "live"
                entry_fix = True
            else:
                state = "bad" if blocked.get(sp.id) else "live"
        elif sp.upload_status == "uploaded":
            state = "live"
        else:
            state = "bad" if blocked.get(sp.id) else "ready"
        entry = entries.get(key)
        if entry is None:
            entry = entries[key] = {
                "key": key,
                "ean": ean or None,
                "title": "",
                "image": None,
                "stores": {},
                "product_id": p.id,
                "batch_id": p.batch_id,
                "created_at": p.created_at.isoformat(),
                "fixes": 0,
                "_titles": set(),
            }
        if title:
            entry["_titles"].add(_norm(title))
        image = _text(own.get("image"))
        # The newest new-products batch is the place to work on a product: every store side by side.
        if p.kind == "new":
            entry.update(product_id=p.id, batch_id=p.batch_id, created_at=p.created_at.isoformat())
            entry["title"] = title or entry["title"]
        if not entry["title"]:
            entry["title"] = title
        if not entry["image"] and image.startswith(("http", "/api/media/")):
            entry["image"] = image
        if sp.store_key not in order:
            order.append(sp.store_key)
        current = entry["stores"].get(sp.store_key)
        # What the store shows (its audit) wins over what was prepared here; a newer batch over an older one.
        if current is None or p.kind == "audit" or current["kind"] != "audit":
            entry["stores"][sp.store_key] = {
                "state": state,
                "product_id": p.id,
                "batch_id": p.batch_id,
                "kind": p.kind,
                "fixes": entry_fix,
            }
    _merge_by_title(entries)
    out = []
    for entry in entries.values():
        entry.pop("_titles", None)
        entry["fixes"] = sum(1 for s in entry["stores"].values() if s.pop("fixes", False))
        entry["missing"] = sum(1 for k in order if k not in entry["stores"])
        out.append(entry)
    out.sort(key=lambda e: (e["title"] or "").casefold())
    return out, order


def _norm(title: str) -> str:
    return " ".join(title.casefold().split())


def _merge_by_title(entries: dict[str, dict]) -> None:
    """A store that keeps no EAN (or another code) still lists the product under the same title: such a row
    joins the product with an EAN and that title, when the store is not in it yet."""
    by_title: dict[str, dict] = {}
    for entry in entries.values():
        if entry["ean"]:
            for t in entry["_titles"]:
                by_title.setdefault(t, entry)
    for key in [k for k, e in entries.items() if not e["ean"]]:
        entry = entries[key]
        target = next((by_title[t] for t in entry["_titles"] if t in by_title), None)
        if target is None or set(entry["stores"]) & set(target["stores"]):
            continue
        target["stores"].update(entry["stores"])
        target["_titles"] |= entry["_titles"]
        target["image"] = target["image"] or entry["image"]
        del entries[key]


def _matches(entry: dict, words: list[str]) -> bool:
    text = f"{entry['title']} {entry['ean'] or ''}".casefold()
    return all(w in text for w in words)


def catalog(q: str = "", filter: str = "all", offset: int = 0, limit: int = 100) -> dict:
    from db.stores import list_stores

    entries, present = _entries()
    words = q.casefold().split()
    found = [e for e in entries if _matches(e, words)] if words else entries
    counts = {name: sum(1 for e in found if test(e)) for name, test in FILTERS.items()}
    shown = [e for e in found if FILTERS.get(filter, FILTERS["all"])(e)]
    known = {s["key"]: s for s in list_stores()}
    stores = [k for k in known if k in present] + [k for k in present if k not in known]
    return {
        "stores": [
            {
                "key": k,
                "label": (known.get(k) or {}).get("label", k).split(" (")[0],
                "country": (known.get(k) or {}).get("country"),
                "language": (known.get(k) or {}).get("language"),
            }
            for k in stores
        ],
        "total": len(entries),
        "counts": counts,
        "items": shown[offset : offset + limit],
        "found": len(shown),
    }


def entry_for(product_id: int) -> dict:
    """The catalog entry a product belongs to: the same product in the other stores."""
    entries, _ = _entries()
    for e in entries:
        if e["product_id"] == product_id or any(s["product_id"] == product_id for s in e["stores"].values()):
            return e
    raise KeyError(f"Няма продукт {product_id}.")
