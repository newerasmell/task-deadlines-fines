"""Filling a store's catalog from the other stores' catalogs: the same product (same EAN, from each audit) has a
picture, a description, notes… in one store and not in another. The person sees what can come from where and
approves it per kind; then pictures are composed by this store's layout, descriptions and notes translated into
its language, and gender, family and ingredients copied. The results are fixes like any other: written live with
„Обнови в магазина“."""

import threading
import time
import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from db import newbatch
from db.models import Batch, Event, FieldRow, Media, Product, StoreProduct
from pipeline.config import load_group

KINDS = {
    "image": "Снимка",
    "body_html": "Описание",
    "top_note": "Горни нотки",
    "middle_note": "Средни нотки",
    "base_note": "Базови нотки",
    "gender": "Пол",
    "fragrance_family": "Семейство",
    "ingredients": "Съставки",
}
COPY = ("gender", "fragrance_family", "ingredients")  # the same in every language (vocabulary, INCI)
NOTES = ("top_note", "middle_note", "base_note")
TEXT_COST, NOTE_COST = 0.004, 0.001  # USD per product, Sonnet without thinking


def _engine():
    from db.repo import engine

    return engine()


def _empty(value) -> bool:
    return value is None or str(value).strip() in ("", "None", "nan")


def _rows_by_product(session: Session, batch_id: int) -> dict[int, dict[str, FieldRow]]:
    out: dict[int, dict[str, FieldRow]] = {}
    rows = session.execute(
        select(FieldRow, StoreProduct.product_id)
        .join(StoreProduct, StoreProduct.id == FieldRow.store_product_id)
        .join(Product, Product.id == StoreProduct.product_id)
        .where(Product.batch_id == batch_id, FieldRow.key.in_(["ean", "title", *KINDS]))
    ).all()
    for row, product_id in rows:
        out.setdefault(product_id, {})[row.key] = row
    return out


def _donors(session: Session, batch: Batch) -> list[Batch]:
    """The latest audit of every other store."""
    audits = session.execute(
        select(Batch).where(Batch.kind == "audit", Batch.store_key != batch.store_key).order_by(Batch.id.desc())
    ).scalars()
    latest: dict[str, Batch] = {}
    for b in audits:
        latest.setdefault(b.store_key, b)
    return list(latest.values())


def _plan(batch_id: int) -> tuple[Batch, dict[str, list[dict]]]:
    """kind -> [{product_id, title, store, value}] for this audit's empty fields that a same-EAN product of another
    store has."""
    with Session(_engine()) as session:
        batch = session.get(Batch, batch_id)
        if batch is None or batch.kind != "audit":
            raise KeyError(f"Няма одит {batch_id}.")
        here = _rows_by_product(session, batch_id)
        by_ean: dict[str, list[tuple[str, dict[str, FieldRow]]]] = {}
        for donor in _donors(session, batch):
            for fields in _rows_by_product(session, donor.id).values():
                code = str(fields["ean"].value or "").strip() if "ean" in fields else ""
                if code:
                    by_ean.setdefault(code, []).append((donor.store_key, fields))
        session.expunge_all()
    plan: dict[str, list[dict]] = {k: [] for k in KINDS}
    for product_id, fields in here.items():
        code = str(fields["ean"].value or "").strip() if "ean" in fields else ""
        if not code or code not in by_ean:
            continue
        for kind in KINDS:
            if kind not in fields or not _empty(fields[kind].value):
                continue
            donor = next(((s, f) for s, f in by_ean[code] if kind in f and not _empty(f[kind].value)), None)
            if donor:
                plan[kind].append(
                    {
                        "product_id": product_id,
                        "title": str(fields["title"].value or "") if "title" in fields else "",
                        "store": donor[0],
                        "value": donor[1][kind].value,
                    }
                )
    return batch, plan


def options(batch_id: int) -> dict:
    """What can be filled from the other stores, per kind: how many products, from which stores, examples."""
    batch, plan = _plan(batch_id)
    group = load_group(batch.group_key) if batch.group_key else None

    def label(key: str) -> str:
        return group.stores[key].label if group and key in group.stores else key

    out = []
    for kind, items in plan.items():
        if not items:
            continue
        stores = sorted({i["store"] for i in items})
        cost = len(items) * (TEXT_COST if kind == "body_html" else NOTE_COST if kind in NOTES else 0)
        out.append(
            {
                "kind": kind,
                "label": KINDS[kind],
                "products": len(items),
                "from": [label(s) for s in stores],
                "cost_usd": round(cost, 2),
                "examples": [
                    {"title": i["title"], "from": label(i["store"]), "value": str(i["value"])[:160]} for i in items[:5]
                ],
            }
        )
    return {"batch_id": batch_id, "kinds": out}


def start(batch_id: int, kinds: list[str], actor: str | None, client=None, fetch=None) -> str:
    kinds = [k for k in kinds if k in KINDS]
    if not kinds:
        raise newbatch.NewBatchError("Избери какво да се попълни.")
    with newbatch._lock:
        if any(j["running"] for j in newbatch._jobs.values()):
            raise newbatch.NewBatchError("Вече върви задача; изчакай да свърши.")
        job_id = uuid.uuid4().hex[:12]
        newbatch._jobs[job_id] = {
            "id": job_id,
            "kind": "crosssync",
            "running": True,
            "stage": "fields",
            "stage_label": "Попълвам от другите магазини",
            "done": 0,
            "total": 0,
            "error": None,
            "batch_id": None,
            "target_batch_id": batch_id,
            "result": None,
            "cost_usd": None,
            "started_at": time.time(),
            "finished_at": None,
        }
    job = newbatch._jobs[job_id]

    def work():
        try:
            result, cost = run(batch_id, kinds, actor, client, fetch, job)
            job.update({"result": result, "cost_usd": cost})
        except Exception as exc:
            job["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            job.update({"running": False, "finished_at": time.time()})

    threading.Thread(target=work, daemon=True, name=f"crosssync-{job_id}").start()
    return job_id


def run(batch_id: int, kinds: list[str], actor: str | None, client=None, fetch=None, job: dict | None = None):
    """Apply the approved kinds. Returns ({kind: filled count}, cost)."""
    from db.repo import media_url
    from pipeline import images, media
    from pipeline.ai import default_client
    from pipeline.compose import compose_for_stores
    from pipeline.fill import normalize_notes, translate_html, translate_terms

    batch, plan = _plan(batch_id)
    group = load_group(batch.group_key)
    store = group.stores.get(batch.store_key)
    language = store.language if store else "en"
    todo = [(kind, item) for kind in kinds for item in plan.get(kind, [])]
    if job is not None:
        job["total"] = len(todo)
    ai = None
    cost = 0.0
    filled = {k: 0 for k in kinds}
    failed: dict[str, int] = {}
    for kind, item in todo:
        try:
            value = item["value"]
            note = f"От {item['store']}"
            if kind == "body_html" and language:
                ai = ai or client or default_client()
                value, usage = translate_html(ai, str(value), language)
                cost += usage.cost
                note += ", преведено"
            elif kind in NOTES:
                ai = ai or client or default_client()
                english, usage = normalize_notes(ai, str(value))
                cost += usage.cost
                local, usage2 = translate_terms(ai, english, language)
                cost += usage2.cost
                value = ", ".join(local.get(t, t) for t in english)
                note += ", преведено"
            new_media = None
            if kind == "image":
                data = (fetch or images.fetch)(str(value))
                composed = compose_for_stores(data, group, [batch.store_key]).get(batch.store_key)
                new_media = (data, composed, str(value))
                note += ", сглобено по фона на магазина" if composed else ""
            with Session(_engine()) as session, session.begin():
                sp = (
                    session.execute(select(StoreProduct).where(StoreProduct.product_id == item["product_id"]))
                    .scalars()
                    .first()
                )
                row = session.execute(
                    select(FieldRow).where(FieldRow.store_product_id == sp.id, FieldRow.key == kind)
                ).scalar_one()
                if not _empty(row.value):  # filled meanwhile: a person's value wins
                    continue
                if new_media:
                    data, composed, source = new_media

                    def add(blob, kind_, layout, info, product_id=item["product_id"], src=source):
                        stored = media.write(blob)
                        m = Media(
                            product_id=product_id,
                            kind=kind_,
                            layout=layout,
                            source_url=src,
                            path=stored.path,
                            content_type=stored.content_type,
                            width=stored.width,
                            height=stored.height,
                            bytes=stored.bytes,
                            sha256=stored.sha256,
                            info=info,
                        )
                        session.add(m)
                        session.flush()
                        return m

                    original = add(data, "original", None, {"source": source})
                    finished = (
                        add(composed.data, "composed", composed.layout, {"warnings": composed.warnings})
                        if composed
                        else None
                    )
                    value = media_url((finished or original).id)
                    row.alternatives = [media_url(original.id)] if finished else []
                row.previous = row.value if row.value is not None else ""
                row.value = value
                row.origin, row.status = "input", "ok"
                row.message = f"{note}. Одобрено от {actor or 'екипа'}."
                row.issues = []
                row.decided_by = actor
                filled[kind] += 1
        except Exception as exc:  # one product's problem never stops the others
            failed[kind] = failed.get(kind, 0) + 1
            if job is not None:
                job["last_error"] = f"{item.get('title', '')}: {type(exc).__name__}: {exc}"
        if job is not None:
            job["done"] += 1
    with Session(_engine()) as session, session.begin():
        session.add(
            Event(
                actor=actor,
                kind="crosssync",
                batch_id=batch_id,
                payload={"filled": filled, "failed": failed, "cost_usd": round(cost, 4)},
            )
        )
    result = {
        KINDS[k]: f"{n} попълнени" + (f", {failed[k]} неуспешни" if failed.get(k) else "") for k, n in filled.items()
    }
    return result, round(cost, 4)
