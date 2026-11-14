"""„Свържи магазин“: a store set up from the app with its Shopify address and access only (docs/decisions.md #48).

The access is saved and checked, then the store's products are read from Shopify and its template is learned from
them exactly as from an uploaded export (db.stores.analyze); the person checks the proposed template and accepts
it, which saves the products as the store's catalog. The same for an existing store whose template should be
learned again. A background job: a catalog of 1000 products takes about a minute."""

import csv
import io
import threading
import time
import uuid

from sqlalchemy.orm import Session

from db import newbatch, stores
from db.models import Store
from pipeline import shopify
from pipeline.config import list_groups, load_group


def _engine():
    from db.repo import engine

    return engine()


def _known() -> dict[str, str]:
    return {k: g for g in list_groups() for k in load_group(g).stores}


def prepare(
    store_key: str | None,
    name: str,
    group_key: str | None,
    shop: str,
    country: str,
    language: str,
    currency: str,
    client_id: str,
    client_secret: str,
    token: str,
    actor: str | None,
) -> tuple[str, str]:
    """The store in its group with its address and access, checked against Shopify. Returns (key, group)."""
    known = _known()
    key = store_key or stores._store_key(name)
    if not key:
        raise stores.StoreError("Въведи име на магазина.")
    group_key = known.get(key) or group_key
    if not group_key:
        raise stores.StoreError("Избери група за магазина.")
    if key not in known:  # a new store: what the config needs to know about it
        missing = [
            label
            for value, label in ((name, "име"), (country, "държава"), (language, "език"), (currency, "валута"))
            if not value.strip()
        ]
        if missing:
            raise stores.StoreError(f"Попълни {', '.join(missing)}.")
        with Session(_engine()) as session, session.begin():
            row = session.get(Store, key) or Store(key=key, label=name.strip(), group_key=group_key)
            row.group_key = group_key
            row.settings = {
                **(row.settings or {}),
                "label": name.strip(),
                "country": country.strip().upper(),
                "language": language.strip().lower(),
                "currency": currency.strip().upper(),
                "token_env": f"SHOPIFY_TOKEN_{key.upper()}",
            }
            session.add(row)
    if shop.strip():
        stores.set_shop(key, shop, actor)
    if client_id.strip() or client_secret.strip() or token.strip():
        stores.set_access(key, client_id, client_secret, token, actor)
    check = stores.check_access(key)
    if not check["ok"]:
        raise stores.StoreError(check["message"])
    return key, group_key


def _csv(columns: list[str], rows: list[dict]) -> bytes:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=columns, extrasaction="ignore")
    writer.writeheader()
    writer.writerows(rows)
    return out.getvalue().encode("utf-8")


def start(key: str, group_key: str, actor: str | None, shop=None) -> str:
    """Read the store's products from Shopify and learn its template; the job's result names the profile."""
    with newbatch._lock:
        newbatch.busy(sync=True)
        job_id = uuid.uuid4().hex[:12]
        newbatch._jobs[job_id] = {
            "id": job_id,
            "kind": "sync",
            "running": True,
            "stage": "fetch",
            "stage_label": "Чета продуктите от Shopify, за да науча шаблона",
            "done": 0,
            "total": 0,
            "error": None,
            "batch_id": None,
            "result": None,
            "cost_usd": None,
            "store": key,
            "started_at": time.time(),
            "finished_at": None,
        }
    job = newbatch._jobs[job_id]

    def work() -> None:
        try:
            client = shop or shopify.store_client(load_group(group_key), key)
            columns, rows = shopify.catalog_rows(client, lambda n: job.update(done=n))
            if not rows:
                raise stores.StoreError("Магазинът не върна нито един продукт.")
            job.update(stage="check", stage_label=f"Уча шаблона от {len(rows)} продукта")
            label = load_group(group_key).stores[key].label
            profile_id = stores.analyze(
                _csv(columns, rows), f"shopify-{key}.csv", name=label, store_key=key, group_key=group_key, actor=actor
            )
            job["result"] = {"stores": [], "errors": [], "profile_id": profile_id}
        except Exception as exc:
            job["error"] = f"{exc}" if isinstance(exc, stores.StoreError) else f"{type(exc).__name__}: {exc}"
            job["result"] = {"stores": [], "errors": [job["error"]]}
        finally:
            job.update(running=False, finished_at=time.time())

    threading.Thread(target=work, daemon=True, name=f"connect-{job_id}").start()
    return job_id
