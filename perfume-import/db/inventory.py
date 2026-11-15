"""„Включи наличностите“: inventory tracking turned on for the products this app created in the stores.

Products made here before tracking was always on (decisions #52) went up with it off in the stores of a group
learned from its stores. A background job of the Shopify kind (it runs beside an AI job): every product the
app created and sent, store by store; each store's result is reported, one failing store does not stop the
others."""

import threading
import time
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from db import newbatch
from db.models import Batch, Product, StoreProduct
from pipeline.config import load_group
from pipeline.shopify import ShopifyError, store_client, track_inventory


class InventoryError(Exception):
    """Bulgarian message."""


def _engine():
    from db.repo import engine

    return engine()


def made_here() -> dict[str, list[str]]:
    """Per store, the Shopify ids of the products the app created there."""
    out: dict[str, list[str]] = {}
    with Session(_engine()) as session:
        rows = session.execute(
            select(StoreProduct.store_key, StoreProduct.shopify_product_id)
            .join(Product, Product.id == StoreProduct.product_id)
            .join(Batch, Batch.id == Product.batch_id)
            .where(Batch.kind == "new", StoreProduct.shopify_product_id.is_not(None))
            .order_by(StoreProduct.id)
        ).all()
    for store, gid in rows:
        if gid not in out.setdefault(store, []):
            out[store].append(gid)
    return out


def run_store(store_key: str, gids: list[str], shop=None) -> tuple[int, int]:
    """(products changed, products looked at) for one store."""
    from db.stores import list_stores

    group = next((s["group"] for s in list_stores() if s["key"] == store_key), None)
    if not group:
        raise InventoryError(f"{store_key} няма група.")
    shop = shop or store_client(load_group(group), store_key)
    changed = sum(1 for gid in gids if track_inventory(shop, gid))
    return changed, len(gids)


def start(actor: str | None, shops: dict | None = None) -> str:
    todo = made_here()
    if not todo:
        raise InventoryError("Няма продукти, създадени от приложението в магазините.")
    with newbatch._lock:
        newbatch.busy(sync=True)
        job_id = uuid.uuid4().hex[:12]
        newbatch._jobs[job_id] = {
            "id": job_id,
            "kind": "sync",
            "running": True,
            "stage": "fetch",
            "stage_label": "Включвам проследяването на наличностите",
            "done": 0,
            "total": sum(len(v) for v in todo.values()),
            "error": None,
            "batch_id": None,
            "result": None,
            "cost_usd": None,
            "store": None,
            "started_at": time.time(),
            "finished_at": None,
        }
    job = newbatch._jobs[job_id]

    def work() -> None:
        lines, errors, done = [], [], 0
        for store, gids in todo.items():
            job.update(store=store)
            try:
                changed, seen = run_store(store, gids, (shops or {}).get(store))
                lines.append(f"{store}: {changed} от {seen}")
            except (ShopifyError, InventoryError, KeyError) as exc:
                errors.append(f"{store}: {exc}")
            done += len(gids)
            job["done"] = done
        message = "Проследяването на наличностите е включено (променени от проверени): " + ", ".join(lines)
        job.update(
            result={"stores": [], "errors": errors, "message": message if lines else None},
            error="; ".join(errors) if errors and not lines else None,
            running=False,
            finished_at=time.time(),
        )

    threading.Thread(target=work, daemon=True, name=f"inventory-{job_id}").start()
    return job_id
