"""„Попълни липсващото“: a product's empty or blocked facts filled from a linked page or a short targeted search,
as suggestions for every store (notes in each store's language), with the page or search results as sources.
Runs as a background job like a new batch (db.newbatch registry: one at a time, progress, lost on a restart).
"""

import threading
import time
import uuid

from sqlalchemy.orm import Session

from db import newbatch
from db.models import Batch, Event, FieldRow, Product, StoreProduct
from pipeline.ai import api_key
from pipeline.config import load_group
from pipeline.fill import FILLABLE, find_missing, translate_terms

NOTES = ("top_note", "middle_note", "base_note")
LABELS = {
    "vendor": "марка",
    "name": "име",
    "concentration": "концентрация",
    "gender": "пол",
    "fragrance_family": "семейство",
    "top_note": "горни нотки",
    "middle_note": "средни нотки",
    "base_note": "базови нотки",
    "ingredients": "съставки",
    "ean": "EAN",
}


def _engine():
    from db.repo import engine

    return engine()


def _empty(value) -> bool:
    return value in (None, "", [], "None")


def _rows(session: Session, product_id: int) -> dict[str, dict[str, FieldRow]]:
    from db.review import _product_rows

    return _product_rows(session, product_id)


def missing(product_id: int) -> dict:
    """The fillable fields that are empty or blocked in any store of the product."""
    with Session(_engine()) as session:
        product = session.get(Product, product_id)
        if product is None:
            raise KeyError(f"Няма продукт {product_id}.")
        rows = _rows(session, product_id)
    keys = []
    for key in FILLABLE:
        for fields in rows.values():
            row = fields.get(key)
            if row is not None and (_empty(row.value) or row.status == "blocked"):
                keys.append(key)
                break
    return {"product_id": product_id, "keys": keys, "labels": [LABELS[k] for k in keys]}


def start(product_id: int, url: str | None, actor: str | None, client=None) -> str:
    from db.images import ImageError, _public_url

    if not api_key() and client is None:
        raise newbatch.NewBatchError("Няма ключ за Claude (ANTHROPIC_API_KEY в Render → Environment).")
    if url:
        try:
            url = _public_url(url)
        except ImageError as exc:
            raise newbatch.NewBatchError(str(exc)) from exc
    keys = missing(product_id)["keys"]
    if not keys:
        raise newbatch.NewBatchError("На продукта не му липсва нищо, което може да се попълни.")
    with newbatch._lock:
        if any(j["running"] for j in newbatch._jobs.values()):
            raise newbatch.NewBatchError("Вече върви задача; изчакай да свърши.")
        job_id = uuid.uuid4().hex[:12]
        newbatch._jobs[job_id] = {
            "id": job_id,
            "kind": "fill",
            "running": True,
            "stage": "research",
            "stage_label": "Търся липсващото" if not url else "Чета страницата",
            "done": 0,
            "total": 1,
            "error": None,
            "batch_id": None,
            "product_id": product_id,
            "result": None,
            "cost_usd": None,
            "started_at": time.time(),
            "finished_at": None,
        }
    job = newbatch._jobs[job_id]

    def work() -> None:
        from pipeline.ai import default_client

        try:
            filled, cost = run(product_id, keys, url, actor, client or default_client())
            job.update({"result": filled, "cost_usd": cost, "done": 1})
        except Exception as exc:
            job["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            job.update({"running": False, "finished_at": time.time()})

    threading.Thread(target=work, daemon=True, name=f"fill-{job_id}").start()
    return job_id


def run(product_id: int, keys: list[str], url: str | None, actor: str | None, client) -> tuple[dict, float]:
    """Ask, translate the notes per language, write the suggestions. Returns ({field: summary}, cost)."""
    from db.review import _withdraw_approval

    with Session(_engine()) as session:
        product = session.get(Product, product_id)
        batch = session.get(Batch, product.batch_id)
        group = load_group(batch.group_key)
        rows = _rows(session, product_id)
        first = next(iter(rows.values()), {})
        title = " ".join(
            str(first[k].value) for k in ("vendor", "name", "concentration") if k in first and first[k].value
        ) or product.input.get("name", "")
        ml = product.input.get("ml")

    research_keys = list(dict.fromkeys(FILLABLE[k] for k in keys))
    found, result = find_missing(client, title, ml, research_keys, group, url)
    cost = result.usage.cost
    source = url or "търсене"

    languages = {group.store(s).language for s in rows if s in group.stores}
    translations: dict[str, dict[str, str]] = {}
    terms = sorted({t for k in NOTES if k in keys for t in (found[k].value or [])})
    for language in languages:
        translations[language], usage = translate_terms(client, terms, language) if terms else ({}, None)
        cost += usage.cost if usage else 0

    summary: dict[str, str] = {}
    with Session(_engine()) as session, session.begin():
        product = session.get(Product, product_id)
        rows = _rows(session, product_id)
        for key in keys:
            fact = found[FILLABLE[key]]
            if _empty(fact.value):
                summary[key] = "не е намерено"
                continue
            for store, fields in rows.items():
                row = fields.get(key)
                if row is None or not (_empty(row.value) or row.status == "blocked"):
                    continue
                note = f"Допълнено от {source}."
                if key == "ean":  # never written by the AI (CLAUDE.md #6): offered to pick
                    row.alternatives = list(dict.fromkeys([*(row.alternatives or []), str(fact.value)]))
                    row.message = f"Източникът дава EAN {fact.value} за този обем: избери го или въведи от опаковката."
                    continue
                if key in NOTES:
                    language = group.store(store).language if store in group.stores else "en"
                    local = [translations.get(language, {}).get(t, t) for t in fact.value]
                    value, value_en = ", ".join(local), ", ".join(fact.value)
                else:
                    value, value_en = fact.value, None
                row.previous = row.value
                row.value, row.value_en = value, value_en
                row.origin, row.status = "ai_research", "suggested"
                row.sources = fact.sources
                row.confidence = fact.confidence
                row.message = f"{note} {fact.message or ''}".strip()
                row.issues = [{"status": "suggested", "rule": "filled", "message": row.message}]
                row.decided_by = row.decided_at = None
            summary[key] = ", ".join(fact.value) if isinstance(fact.value, list) else str(fact.value)
        # The research kept with the product learns the new facts, so stores added later get them too.
        raw = dict(product.research or {})
        for key in keys:
            fact = found[FILLABLE[key]]
            if not _empty(fact.value):
                raw[FILLABLE[key]] = {"value": fact.value, "sources": fact.sources}
        raw["_sources_seen"] = sorted(set(raw.get("_sources_seen", [])) | {s["url"] for s in result.sources})
        product.research = raw
        _withdraw_approval(session, product_id)
        session.add(
            Event(
                actor=actor,
                kind="ai_usage",
                batch_id=product.batch_id,
                payload={"name": product.input.get("name"), "fill": keys, "source": source, "cost_usd": round(cost, 4)},
            )
        )
    return summary, round(cost, 4)


def sync_notes(field_id: int, text: str, actor: str | None, client=None) -> dict:
    """A person's notes for one level (pasted in any form) -> English names -> every store in its language.
    The person's input: set as decided, not as a suggestion. Returns the product."""
    from db.review import _product_json, _withdraw_approval, now
    from pipeline.ai import default_client
    from pipeline.fill import normalize_notes

    if not text.strip():
        raise newbatch.NewBatchError("Въведи нотките.")
    client = client or default_client()
    with Session(_engine()) as session:
        row = session.get(FieldRow, field_id)
        if row is None or row.key not in NOTES:
            raise KeyError("Няма такова поле с нотки.")
        product_id = session.get(StoreProduct, row.store_product_id).product_id
        product = session.get(Product, product_id)
        group = load_group(session.get(Batch, product.batch_id).group_key)
        key = row.key
        stores = list(_rows(session, product_id))

    notes, usage = normalize_notes(client, text)
    if not notes:
        raise newbatch.NewBatchError("Не разпознах нотки в текста.")
    cost = usage.cost
    by_language = {}
    for language in {group.store(s).language for s in stores if s in group.stores}:
        by_language[language], used = translate_terms(client, notes, language)
        cost += used.cost

    with Session(_engine()) as session, session.begin():
        rows = _rows(session, product_id)
        when = now()
        for store, fields in rows.items():
            target = fields.get(key)
            if target is None:
                continue
            language = group.store(store).language if store in group.stores else "en"
            target.previous = target.value
            target.value = ", ".join(by_language.get(language, {}).get(n, n) for n in notes)
            target.value_en = ", ".join(notes)
            target.origin, target.status = "input", "ok"
            target.message = f"Въведено от {actor or 'екипа'} и преведено за всеки магазин."
            target.issues = []
            target.decided_by, target.decided_at = actor, when
        product = session.get(Product, product_id)
        raw = dict(product.research or {})
        raw[key] = {"value": notes, "sources": [{"url": "", "says": f"въведено от {actor}", "supports": True}]}
        product.research = raw
        _withdraw_approval(session, product_id)
        session.add(
            Event(
                actor=actor,
                kind="notes_synced",
                batch_id=product.batch_id,
                payload={"product": product_id, "key": key, "notes": notes, "cost_usd": round(cost, 4)},
            )
        )
        session.flush()
        return _product_json(session, product_id)
