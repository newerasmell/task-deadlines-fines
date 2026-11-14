"""The product list across every store: one entry per EAN (or per product without one), with what each store
has. A store's copy comes from its latest catalog audit (it is live there) or from a new-products batch
(prepared here, uploaded or not). An audit wins over a batch for the same store: it is what the store shows."""

import threading

from sqlalchemy import Numeric, case, func, literal_column, select
from sqlalchemy.orm import Session

from db.live import LABELS
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


_building = threading.Lock()


def _refresh_in_background() -> None:
    def work():
        try:
            _entries()
        except Exception:  # the next request builds it again
            pass

    if not _building.locked():
        threading.Thread(target=work, daemon=True, name="catalog-build").start()


def _entries(fresh: bool = True) -> tuple[list[dict], list[str]]:
    """fresh=False (the app's list and the stores of a product): when the data changed since the last build,
    the last list is returned at once and a new one is built in the background, so a page never waits for the
    whole list of every store to be built again after each edit."""
    with Session(_engine()) as session:
        version = _version(session)
        if _cache.get("version") == version:
            return _cache["value"]
    if not fresh and "value" in _cache:
        _refresh_in_background()
        return _cache["value"]
    # One build at a time: requests that come meanwhile (typing in the search) wait and take its result instead
    # of each building the whole list again (10 stores at once ran the 512 MB server out of memory).
    with _building:
        with Session(_engine()) as session:
            version = _version(session)
            if _cache.get("version") != version:
                _cache["value"] = _build(session)
                _cache["version"] = version
                built = True
            else:
                built = False
        if built:
            _give_back()
        return _cache["value"]


def _give_back() -> None:
    """Return the memory a build used for a moment to the system: Python keeps freed memory otherwise, and the
    server sat at two thirds of its 512 MB doing nothing (Render's memory graph)."""
    import ctypes
    import gc

    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):  # not glibc (a developer's Mac): nothing to give back this way
        pass


def _comparable(col):
    """db.live.comparable in SQL: tags out, a few entities, spacing collapsed, a plain number with two decimals."""
    text = func.coalesce(col.op("#>>")(literal_column("'{}'")), "")
    text = func.regexp_replace(text, "<[^>]+>", " ", "g")
    for entity, char in (
        ("&nbsp;", " "),
        ("&amp;", "&"),
        ("&quot;", '"'),
        ("&#39;", "'"),
        ("&lt;", "<"),
        ("&gt;", ">"),
    ):
        text = func.replace(text, entity, char)
    text = func.btrim(func.regexp_replace(text, r"\s+", " ", "g"))
    number = func.to_char(func.cast(func.replace(text, ",", "."), Numeric), "FM9999999999999999990.00")
    return case((text.op("~")(r"^\d+([.,]\d+)?$"), number), else_=text)


def _build(session: Session) -> tuple[list[dict], list[str]]:
    latest_audit = select(func.max(Batch.id)).where(Batch.kind == "audit").group_by(Batch.store_key)
    listed = (Batch.kind == "new") | Batch.id.in_(latest_audit)
    # Only the name the list shows from the input, not the whole input.
    named = func.coalesce(Product.input["name"].astext, Product.input["title"].astext, "").label("named")
    rows = session.execute(
        select(Product.id, Product.batch_id, Product.ean, named, Batch.kind, Batch.created_at)
        .join(Batch, Batch.id == Product.batch_id)
        .where(listed)
        .order_by(Product.id)
    ).all()
    products = {r.id: r for r in rows}
    # The same products as a subquery: the database picks their rows, no list of every id is sent with each query
    # (17 000 ids written into the SQL cost the server ~70 MB a build).
    listed_products = select(Product.id).join(Batch, Batch.id == Product.batch_id).where(listed)
    sps = session.execute(
        select(StoreProduct.id, StoreProduct.product_id, StoreProduct.store_key, StoreProduct.upload_status)
        .where(StoreProduct.product_id.in_(listed_products))
        .order_by(StoreProduct.id)
    ).all()
    sps = [sp for sp in sps if sp.product_id in products]  # a product added between the two reads waits
    sp_ids = select(StoreProduct.id).where(StoreProduct.product_id.in_(listed_products))
    blocked = dict(
        session.execute(
            select(FieldRow.store_product_id, func.count())
            .where(FieldRow.store_product_id.in_(sp_ids), FieldRow.status == "blocked")
            .group_by(FieldRow.store_product_id)
        ).all()
    )
    values: dict[int, dict[str, object]] = {}
    skus: dict[int, set[str]] = {}
    eans: dict[int, set[str]] = {}
    # Streamed in chunks (not every row at once), the store's earlier value only where the link needs it.
    for sp_id, key, value, previous in session.execute(
        select(
            FieldRow.store_product_id,
            FieldRow.key,
            FieldRow.value,
            case((FieldRow.key.in_(["sku", "ean"]), FieldRow.previous), else_=None),
        )
        .where(
            FieldRow.store_product_id.in_(sp_ids),
            FieldRow.key.in_(["title", "ean", "image", "sku", "product_milliliters"]),
        )
        .execution_options(yield_per=5000)
    ):
        values.setdefault(sp_id, {})[key] = value
        if key == "sku":  # the code here and the one the store still shows: both keep the link (decisions #36)
            skus[sp_id] = {c for c in (_code(value), _code(previous)) if c}
        if key == "ean":  # likewise the EAN: a new one set here does not cut the product off its stores
            eans[sp_id] = {c for c in (_text(value), _text(previous)) if c}
    # Only rows that differ at all, and the comparison itself in the database (as db.live.same sees a value:
    # HTML tags, entities, spacing and how a number is written do not count), so the list never loads the values
    # (with group 2 the stores' values ran the 512 MB server out of memory). A change a person or the AI made
    # waits to go live (diff); a fix the store's rules made by themselves is counted apart, so the list is not
    # all orange after every catalog check.
    changed: set[int] = set()
    fixes: set[int] = set()
    rule_fix = (FieldRow.origin == "auto_fix") & FieldRow.decided_by.is_(None)
    for sp_id, waiting, fixed in session.execute(
        select(
            FieldRow.store_product_id,
            func.bool_or(~rule_fix),  # a change a person or the AI made
            func.bool_or(rule_fix),  # a fix the store's rules made by themselves
        )
        .where(
            FieldRow.store_product_id.in_(sp_ids),
            FieldRow.previous.is_not(None),
            func.jsonb_typeof(FieldRow.previous) != "null",
            FieldRow.key.in_(list(LABELS)),
            FieldRow.status != "blocked",
            FieldRow.value.is_distinct_from(FieldRow.previous),
            _comparable(FieldRow.value).is_distinct_from(_comparable(FieldRow.previous)),
        )
        .group_by(FieldRow.store_product_id)
    ):
        if waiting:
            changed.add(sp_id)
        if fixed:
            fixes.add(sp_id)

    groups = _link(sps, products, values, skus, eans)
    entries: dict[str, dict] = {}
    order: list[str] = []
    for sp in sps:
        p = products[sp.product_id]
        own = values.get(sp.id, {})
        ean = _text(p.ean) or _text(own.get("ean"))
        title = _text(own.get("title")) or _text(p.named)
        key = f"g{groups.find(sp.id)}"
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
                "ids": [],
            }
        entry["ids"].append(p.id)  # every copy, also one hidden behind its store's own (entry_for finds it)
        entry["ean"] = entry["ean"] or ean or None
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
    out = []
    for entry in entries.values():
        entry["fixes"] = sum(1 for s in entry["stores"].values() if s.pop("fixes", False))
        entry["missing"] = sum(1 for k in order if k not in entry["stores"])
        out.append(entry)
    out.sort(key=lambda e: (e["title"] or "").casefold())
    return out, order


def _norm(title: str) -> str:
    return " ".join(title.casefold().split())


class _Groups:
    """Union-find over store copies: copies that share a key are one product."""

    def __init__(self):
        self.parent: dict[int, int] = {}

    def find(self, x: int) -> int:
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        self.parent[self.find(a)] = self.find(b)


def _code(value) -> str:
    return " ".join(str(value or "").split()).upper()


def _ml(title: str, value) -> str:
    """The volume („15“ for 15 ml): a decant and the full bottle share an EAN but are not the same product."""
    import re

    for text in (str(value or ""), title):
        if m := re.search(r"(\d+(?:[.,]\d+)?)\s*ml", text, re.IGNORECASE):
            return m.group(1).replace(",", ".").rstrip("0").rstrip(".")
    return ""


def _identity(title: str, ml_value) -> tuple[str, str, bool]:
    """What a code can never override: the brand (the title's first word), the volume and whether it is a
    tester. Codes are reused on several decants (5901234000002), titles are not."""
    words = _norm(title).split()
    return (words[0] if words else "", _ml(title, ml_value), "tester" in words)


def _fits(a: tuple[str, str, bool], b: tuple[str, str, bool]) -> bool:
    """Two identities can be one product: equal wherever both are known."""
    return all(x == y for x, y in zip(a[:2], b[:2], strict=True) if x and y) and a[2] == b[2]


def _link(sps, products, values, skus, eans) -> _Groups:
    """Which store copies are the same product (decisions #40). A copy links to another through any code they
    share: the SKU (the team's own code), the EAN or the exact title; for SKU and EAN both the value set here
    and the one the store still shows count, so a product stays linked while a new code reaches the stores one
    by one. No code ever joins two copies whose brand, volume or tester differ (codes are reused on several
    decants), and two products both live in one store are never joined."""
    groups = _Groups()
    by_key: dict[str, list[int]] = {}
    who: dict[int, tuple[str, str, bool]] = {}
    for sp in sps:
        own = values.get(sp.id, {})
        p = products[sp.product_id]
        title = _text(own.get("title")) or _text(p.named)
        who[sp.id] = _identity(title, own.get("product_milliliters"))
        codes = ({_text(p.ean)} | eans.get(sp.id, set())) - {""}
        keys = [f"sku:{c}" for c in skus.get(sp.id, ())] + [f"ean:{c}" for c in sorted(codes)]
        if title:  # a store may keep no EAN and its own SKU (TvojaParfum): the same title still links
            keys.append(f"t:{_norm(title)}")
        groups.find(sp.id)
        for k in keys:
            by_key.setdefault(k, []).append(sp.id)
    # Only two products both live in one store are surely different; a copy prepared here and the store's own
    # copy of it are the same product (the store's wins in the entry).
    live_in: dict[int, set[str]] = {
        sp.id: ({sp.store_key} if products[sp.product_id].kind == "audit" else set()) for sp in sps
    }
    identity = dict(who)  # per group: the most complete identity of its members
    for k in sorted(by_key, key=lambda k: (k.split(":", 1)[0] != "sku", k)):  # SKU links first
        ids = by_key[k]
        for i, first in enumerate(ids):
            for other in ids[i + 1 :]:
                a, b = groups.find(first), groups.find(other)
                if a == b or live_in[a] & live_in[b] or not _fits(identity[a], identity[b]):
                    continue
                groups.union(a, b)
                root = groups.find(a)
                live_in[root] = live_in[a] | live_in[b]
                identity[root] = tuple(x or y for x, y in zip(identity[a], identity[b], strict=True))
    return groups


def _matches(entry: dict, words: list[str]) -> bool:
    text = f"{entry['title']} {entry['ean'] or ''}".casefold()
    return all(w in text for w in words)


def catalog(q: str = "", filter: str = "all", offset: int = 0, limit: int = 100, fresh: bool = True) -> dict:
    from db.stores import list_stores

    entries, present = _entries(fresh)
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


def entry_for(product_id: int, fresh: bool = True) -> dict:
    """The catalog entry a product belongs to: the same product in the other stores. With fresh=False the last
    built list is used when it has the product (else it is built now)."""
    for attempt in (fresh, True) if not fresh else (True,):
        entries, _ = _entries(attempt)
        for e in entries:
            if e["product_id"] == product_id or product_id in e["ids"]:
                return e
    raise KeyError(f"Няма продукт {product_id}.")
