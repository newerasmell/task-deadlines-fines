"""„Качи в магазините“: one product, every store it is in or can go to (docs/decisions.md #25).

A store's copy read from that store (its catalog) gets only its changed fields written live (db.live.push); a
copy prepared here (a new product) is created in the store (db.review.publish → db.upload). What waits on a
person (an AI suggestion to accept, a blocked field) is said per store and that store is left out."""

from collections import Counter

from sqlalchemy import select
from sqlalchemy.orm import Session

from db import catalog, live, review
from db.models import FieldRow, StoreProduct


def _engine():
    from db.repo import engine

    return engine()


def _waiting(rows: list[FieldRow]) -> str | None:
    counts = Counter(r.status for r in rows if r.status in ("suggested", "blocked"))
    parts = []
    if counts["suggested"]:
        parts.append(
            f"{counts['suggested']} {'предложение' if counts['suggested'] == 1 else 'предложения'} за приемане"
        )
    if counts["blocked"]:
        parts.append(f"{counts['blocked']} {'поле липсва' if counts['blocked'] == 1 else 'полета липсват'}")
    return " и ".join(parts) or None


def plan(product_id: int) -> dict:
    """Per store: what „Качи“ would do (update the live product / create it), what changes, or why not."""
    entry = catalog.entry_for(product_id)
    out = []
    with Session(_engine()) as session:
        for store, at in entry["stores"].items():
            sp = session.execute(
                select(StoreProduct).where(StoreProduct.product_id == at["product_id"], StoreProduct.store_key == store)
            ).scalar_one_or_none()
            if sp is None:
                continue
            rows = list(session.execute(select(FieldRow).where(FieldRow.store_product_id == sp.id)).scalars())
            item = {"store": store, "product_id": at["product_id"], "batch_id": at["batch_id"], "kind": at["kind"]}
            waiting = _waiting(rows)
            if at["kind"] == "audit":
                changed = live._changes(rows)
                item["changes"] = [live.LABELS[r.key] for r in changed]
                if changed:
                    item.update(action="update", reason=waiting)  # the accepted part goes; the rest waits
                else:
                    item.update(action="none", reason=waiting or "няма промени")
            elif sp.upload_status == "uploaded":
                item.update(action="none", changes=[], reason="вече е качен")
            elif waiting:
                item.update(action="wait", changes=[], reason=waiting)
            else:
                item.update(action="create", changes=[], reason=None)
            item["message"] = sp.upload_message if sp.upload_status == "failed" else None
            out.append(item)
    # Stores of the same group with a template that do not have the product: it can be made for them.
    from db.stores import list_stores

    groups = {s["key"]: s["group"] for s in list_stores()}
    group = next((groups.get(s) for s in entry["stores"] if groups.get(s)), None)
    for s in list_stores():
        if s["group"] == group and s["profile_accepted"] and s["key"] not in entry["stores"]:
            out.append(
                {
                    "store": s["key"],
                    "product_id": None,
                    "batch_id": None,
                    "kind": None,
                    "action": "missing",
                    "changes": [],
                    "reason": None,
                    "message": None,
                }
            )
    return {"key": entry["key"], "ean": entry["ean"], "title": entry["title"], "stores": out}


def _in_euros(row, currency: str, table: dict) -> str:
    from pipeline import fx

    try:
        amount = float(str(row.value).replace(",", ".")) if row is not None and row.value else None
    except ValueError:
        return ""
    value = fx.to_eur(amount, currency, table) if amount else None
    return f"{value:.2f}" if value else ""


def _euro_price(product_id: int) -> tuple[str, str]:
    """The product's price and old price in euros, from a store that has them (for making it in other stores)."""
    from db.models import Batch, Product
    from pipeline import fx
    from pipeline.config import load_group

    entry = catalog.entry_for(product_id)
    _, table = fx.rates()
    with Session(_engine()) as session:
        for store, at in entry["stores"].items():
            group = load_group(session.get(Batch, session.get(Product, at["product_id"]).batch_id).group_key)
            if store not in group.stores:
                continue
            fields = review._product_rows(session, at["product_id"]).get(store, {})
            currency = group.stores[store].currency

            price = _in_euros(fields.get("price"), currency, table)
            if price:
                return price, _in_euros(fields.get("compare_at"), currency, table)
    return "", ""


def run(product_id: int, stores: list[str], status: str, actor: str | None) -> dict:
    """Send the product to these stores. Live updates are done when this returns; new products are created by a
    background upload (its state on the product screen). Returns what happened per store and the new plan."""
    current = {s["store"]: s for s in plan(product_id)["stores"]}
    done: dict[str, str] = {}
    create: dict[int, list[str]] = {}
    missing: list[str] = []
    for store in stores:
        item = current.get(store)
        if item is None:
            done[store] = "продуктът не е в този магазин"
        elif item["action"] == "update":
            try:
                state = live.push(item["product_id"], actor)
            except live.LiveError as exc:
                done[store] = str(exc)
                continue
            ok = state["live_status"] == "uploaded"
            done[store] = state["live_message"] or ("качено" if ok else "не стана")
        elif item["action"] == "create":
            create.setdefault(item["product_id"], []).append(store)
        elif item["action"] == "missing":
            missing.append(store)
        else:
            done[store] = item["reason"] or "няма какво да се качи"
    for pid, keys in create.items():
        try:
            result = review.publish(pid, keys, status, actor)
            for key in result["stores"]:
                done[key] = "създава се в магазина…"
            done.update(result["skipped"])
        except review.ReviewError as exc:
            for key in keys:
                done[key] = str(exc)
    if missing:
        # Made like a quick new product: research by name and EAN (reused when known), each store's text by its
        # template, the price from the euro price of a store that has the product. Reviewed, then sent from here.
        from db import newbatch

        whole = plan(product_id)
        price, compare = _euro_price(product_id)
        item = {"name": whole["title"], "ean": whole["ean"] or "", "price": price, "compare": compare}
        try:
            job_id = newbatch.quick_start([item], missing, actor)
            for store in missing:
                done[store] = "създава се (около минута); после го прегледай и го качи оттук"
            return {"done": done, "plan": plan(product_id), "job_id": job_id}
        except newbatch.NewBatchError as exc:
            for store in missing:
                done[store] = str(exc)
    return {"done": done, "plan": plan(product_id)}
