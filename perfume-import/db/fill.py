"""„Попълни с AI“: a product's empty, blocked or flagged (warning) facts filled from a linked page or a short
targeted search,
as suggestions for every store (notes in each store's language), with the page or search results as sources.
Runs as a background job like a new batch (db.newbatch registry: one at a time, progress, lost on a restart).
"""

import re
import threading
import time
import uuid

from sqlalchemy import select
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
    "body_html": "описание",
}
TEXT_KEYS = ("body_html", "seo_description")


def _engine():
    from db.repo import engine

    return engine()


def _empty(value) -> bool:
    return value in (None, "", [], "None")


def _rows(session: Session, product_id: int) -> dict[str, dict[str, FieldRow]]:
    from db.review import _product_rows

    return _product_rows(session, product_id)


def _weak(row: FieldRow) -> bool:
    """Empty, blocked, or flagged by a rule (a too short description, notes in the wrong script…)."""
    return _empty(row.value) or row.status in ("blocked", "warning")


def missing(product_id: int) -> dict:
    """The fillable fields that are empty, blocked or flagged in any store of the product."""
    with Session(_engine()) as session:
        product = session.get(Product, product_id)
        if product is None:
            raise KeyError(f"Няма продукт {product_id}.")
        rows = _rows(session, product_id)
    keys = []
    for key in [*FILLABLE, "body_html"]:
        for fields in rows.values():
            row = fields.get(key)
            # a field a person accepted as it is (e.g. no published ingredients) is not missing
            decided = row is not None and row.decided_by and row.status == "ok"
            if row is not None and not decided and _weak(row):
                keys.append(key)
                break
    return {"product_id": product_id, "keys": keys, "labels": [LABELS[k] for k in keys]}


def start(product_id: int, url: str | None, actor: str | None, client=None, only: list[str] | None = None) -> str:
    """only: these fields (one field's panel); else every missing one."""
    from db.images import ImageError, _public_url

    if not api_key() and client is None:
        raise newbatch.NewBatchError("Няма ключ за Claude (ANTHROPIC_API_KEY в Render → Environment).")
    if url:
        try:
            url = _public_url(url)
        except ImageError as exc:
            raise newbatch.NewBatchError(str(exc)) from exc
    keys = missing(product_id)["keys"]
    if only:
        keys = [k for k in keys if k in only] or [k for k in only if k in (*FILLABLE, "body_html")]
    if not keys:
        raise newbatch.NewBatchError("На продукта не му липсва нищо, което може да се попълни.")
    with newbatch._lock:
        newbatch.busy()
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

    texts = "body_html" in keys
    forced = set(keys) if len(keys) == 1 else set()  # one field asked for by name is written even if it looks fine
    keys = [k for k in keys if k in FILLABLE]
    research_keys = list(dict.fromkeys(FILLABLE[k] for k in keys))
    found, result = find_missing(client, title, ml, research_keys, group, url) if keys else ({}, None)
    cost = result.usage.cost if result else 0.0
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
                if row is None or not (_weak(row) or key in forced):
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
                if row.previous is None:  # the store's value stays the reference until it goes live
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
        if result:
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
    if texts:
        summary["body_html"], text_cost = write_texts(product_id, client, force="body_html" in forced)
        cost += text_cost
    return summary, round(cost, 4)


def _facts(fields: dict[str, FieldRow]) -> dict:
    """The facts a description is written from, as they are now in the store (decisions included). A store's
    catalog product has no name or concentration fields: they are read from its title (decisions #24); notes
    without an English reference are given in the store's language and the writer takes them as they are."""
    from pipeline.titles import ABBREVIATIONS, parse_title

    facts = {}
    for key, fact in (("vendor", "brand"), ("name", "name"), ("concentration", "concentration")):
        if key in fields and not _empty(fields[key].value) and fields[key].status != "blocked":
            facts[fact] = fields[key].value
    title = fields.get("title")
    if title is not None and not _empty(title.value) and not facts.get("name"):
        parsed = parse_title(str(title.value), str(facts.get("brand") or ""))
        if parsed.name:
            facts["name"] = parsed.name
        if parsed.concentration and not facts.get("concentration"):
            facts["concentration"] = ABBREVIATIONS.get(parsed.concentration.upper(), parsed.concentration)
        if parsed.brand and not facts.get("brand"):
            facts["brand"] = parsed.brand
    for key in ("gender", "fragrance_family"):
        if key in fields and not _empty(fields[key].value):
            facts[key] = fields[key].value
    for key in NOTES:
        row = fields.get(key)
        notes = (row.value_en or row.value) if row is not None else None
        if notes and row.status != "blocked":
            facts[key] = [t.strip() for t in str(notes).split(",") if t.strip()]
    return facts


def write_texts(
    product_id: int,
    client,
    force: bool = False,
    source: str | None = None,
    only: list[str] | None = None,
    facts: dict | None = None,
) -> tuple[str, float]:
    """English master + every store's text (its own style, or its language's translation) from the current
    facts; written as suggestions into the stores whose description is empty, blocked or flagged (every store
    with force). source: the store whose facts the texts are written from (else the first); only: these stores."""
    from db.stores import accepted_profiles
    from pipeline.generate import generate_texts, store_style, style_key, text_fields
    from pipeline.validate import Context, validate_product

    with Session(_engine()) as session:
        product = session.get(Product, product_id)
        group = load_group(session.get(Batch, product.batch_id).group_key)
        rows = _rows(session, product_id)
        targets = [
            s
            for s, f in rows.items()
            if s in group.stores
            and "body_html" in f
            and (force or (_weak(f["body_html"]) and not (f["body_html"].decided_by and f["body_html"].status == "ok")))
            and (only is None or s in only)
        ]
        first = rows[source] if source in rows else next(iter(rows.values()))
        facts = facts or _facts(first)  # given: the facts of another store's copy (spread_entry)
        title = str((first.get("title") or FieldRow()).value or "")
        tester = bool(product.input.get("tester")) or bool(re.search(r"\btester\b", title, re.IGNORECASE))
    if not targets:
        return "вече има описания", 0.0
    if not facts.get("name"):
        return "липсва име на аромата: първо реши името", 0.0
    profiles = accepted_profiles(targets)
    styles = [st for s in targets if (st := store_style(group.store(s), profiles.get(s), group))]
    styled = {st.key for st in styles}
    languages = [group.store(s).language for s in targets if s not in styled]
    [(master, by_target)] = generate_texts(client, [(facts, tester)], group, languages, batch=False, styles=styles)
    cost = master.usage.cost + sum(t.usage.cost for t in by_target.values())

    with Session(_engine()) as session, session.begin():
        rows = _rows(session, product_id)
        for store in targets:
            style = next((st for st in styles if st.key == store), None)
            text = by_target.get(style_key(style)) if style else by_target.get(group.store(store).language)
            if text is None:
                continue
            made = text_fields(text, master, group)
            fields = {k: _field(r) for k, r in rows[store].items()}
            fields.update({k: made[k] for k in TEXT_KEYS})
            validate_product(fields, Context(group, group.store(store), (style.lo, style.hi) if style else None))
            for key in TEXT_KEYS:
                if key in rows[store]:
                    _write_field(rows[store][key], fields[key])
    return f"написано за {len(targets)} магазина", cost


def _field(row: FieldRow):
    from db.review import to_field

    return to_field(row)


def _write_field(row: FieldRow, f) -> None:
    if row.previous is None:  # the store's value stays the reference until it goes live
        row.previous = row.value
    row.value, row.value_en, row.origin, row.status = f.value, f.value_en, f.origin, f.status
    row.message, row.issues, row.alternatives = f.message, f.issues, f.alternatives
    row.decided_by = row.decided_at = None


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


SPREAD_KEYS = ("vendor", "name", "concentration", "gender", "fragrance_family", "ingredients")


def spread(product_id: int, source: str, actor: str | None, client) -> tuple[dict, float]:
    """„Пренеси към всички“: the store a person got right becomes every other store's truth. Brand, name,
    concentration, gender, family and ingredients are copied, the notes are translated into each store's language
    (English names from the source, read from its own language when it has none), and every other store's
    description and SEO text is written again from these facts in its own template, as suggestions."""
    from db.review import _withdraw_approval, now
    from pipeline.fill import normalize_notes

    with Session(_engine()) as session:
        product = session.get(Product, product_id)
        if product is None:
            raise KeyError(f"Няма продукт {product_id}.")
        group = load_group(session.get(Batch, product.batch_id).group_key)
        rows = _rows(session, product_id)
        if source not in rows:
            raise KeyError(f"Продуктът не е в {source}.")
        src = rows[source]
        others = [s for s in rows if s != source]
        copied = {
            k: src[k].value for k in SPREAD_KEYS if k in src and not _empty(src[k].value) and src[k].status != "blocked"
        }
        local_notes = {
            k: (src[k].value_en, src[k].value)
            for k in NOTES
            if k in src and not _empty(src[k].value) and src[k].status != "blocked"
        }
    if not others:
        raise newbatch.NewBatchError("Продуктът е само в този магазин.")

    cost = 0.0
    english: dict[str, list[str]] = {}
    for key, (value_en, value) in local_notes.items():
        if value_en:
            english[key] = [t.strip() for t in str(value_en).split(",") if t.strip()]
        else:  # notes kept only in the store's language: their English names first
            english[key], usage = normalize_notes(client, str(value))
            cost += usage.cost
    terms = sorted({t for notes in english.values() for t in notes})
    translations: dict[str, dict[str, str]] = {}
    for language in {group.store(s).language for s in others if s in group.stores}:
        translations[language], usage = translate_terms(client, terms, language) if terms else ({}, None)
        cost += usage.cost if usage else 0

    with Session(_engine()) as session, session.begin():
        rows = _rows(session, product_id)
        when = now()
        note = f"От {source}, пренесено от {actor or 'екипа'}."
        for store in others:
            language = group.store(store).language if store in group.stores else "en"
            values = dict(copied)
            values_en = {}
            for key, notes in english.items():
                values[key] = ", ".join(translations.get(language, {}).get(t, t) for t in notes)
                values_en[key] = ", ".join(notes)
            for key, value in values.items():
                row = rows[store].get(key)
                if row is None:
                    continue
                if row.previous is None:  # the store's value stays the reference until it goes live
                    row.previous = row.value
                row.value, row.value_en = value, values_en.get(key, row.value_en)
                row.origin, row.status, row.message, row.issues = "input", "ok", note, []
                row.decided_by, row.decided_at = actor, when
        product = session.get(Product, product_id)
        raw = dict(product.research or {})
        for key, notes in english.items():
            raw[key] = {"value": notes, "sources": [{"url": "", "says": f"от {source}", "supports": True}]}
        product.research = raw
        _withdraw_approval(session, product_id)
    summary, text_cost = write_texts(product_id, client, force=True, source=source, only=others)
    cost += text_cost
    with Session(_engine()) as session, session.begin():
        product = session.get(Product, product_id)
        session.add(
            Event(
                actor=actor,
                kind="spread",
                batch_id=product.batch_id,
                payload={"product": product_id, "from": source, "to": others, "cost_usd": round(cost, 4)},
            )
        )
    return {"Пренесено": f"от {source} към {len(others)} магазина", "Описания": summary}, round(cost, 4)


def start_spread(product_id: int, source: str, actor: str | None, client=None) -> str:
    if not api_key() and client is None:
        raise newbatch.NewBatchError("Няма ключ за Claude (ANTHROPIC_API_KEY в Render → Environment).")
    with newbatch._lock:
        newbatch.busy()
        job_id = uuid.uuid4().hex[:12]
        newbatch._jobs[job_id] = {
            "id": job_id,
            "kind": "fill",
            "running": True,
            "stage": "texts",
            "stage_label": f"Пренасям от {source} и пиша описанията",
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
            result, cost = spread(product_id, source, actor, client or default_client())
            job.update({"result": result, "cost_usd": cost, "done": 1})
        except Exception as exc:
            job["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            job.update({"running": False, "finished_at": time.time()})

    threading.Thread(target=work, daemon=True, name=f"spread-{job_id}").start()
    return job_id


def _copy_image(source_product: int, source_value, target_product: int, actor: str | None) -> str | None:
    """The source copy's picture onto another store's copy: a finished picture as it is, else its original
    composed for the target store's layout. Returns a note when it could not be done."""
    from db import images
    from db.models import Media
    from pipeline import media as files

    text = str(source_value or "")
    try:
        if text.startswith("/api/media/"):
            with Session(_engine()) as session:
                shown = session.get(Media, int(text.rsplit("/", 1)[1]))
                if shown is None:
                    return "снимката не е намерена"
                original = shown
                if shown.kind == "composed":  # compose again from its original for the other layout
                    original = (
                        session.execute(
                            select(Media)
                            .where(Media.product_id == shown.product_id, Media.kind == "original")
                            .order_by(Media.id.desc())
                        )
                        .scalars()
                        .first()
                        or shown
                    )
                data = files.resolve(original.path).read_bytes()
                ready = shown.kind == "original"  # used as it is in its store: a finished picture
        elif text.startswith("http"):
            data, ready = images.from_url(text), False
        else:
            return None
        images.replace(target_product, data, f"от продукта {source_product}", actor, ready)
    except Exception as exc:  # the facts and texts still go; the picture is reported
        return f"снимката не се пренесе: {exc}"
    return None


def spread_entry(product_id: int, stores: list[str], actor: str | None, client) -> tuple[dict, float]:
    """„Качи в магазините“ with „изравни“: the open copy (its store) is the truth for the same product's copies in
    these other stores (each its own product when read from the store). Brand, name, concentration, gender,
    family and ingredients are copied, the notes translated, description and SEO written again in each store's
    template, and the picture copied when it differs. Values are set as decided (the person chose to send them);
    each copy's store value stays as `previous`, so they show and go as changes."""
    from db import catalog
    from db.live import same
    from db.review import _withdraw_approval, now
    from pipeline.fill import normalize_notes

    entry = catalog.entry_for(product_id)
    source = next((s for s, at in entry["stores"].items() if at["product_id"] == product_id), None)
    if source is None:
        raise KeyError(f"Няма продукт {product_id}.")
    targets = {s: at["product_id"] for s, at in entry["stores"].items() if s in stores and s != source}
    if not targets:
        return {}, 0.0
    with Session(_engine()) as session:
        product = session.get(Product, product_id)
        group = load_group(session.get(Batch, product.batch_id).group_key)
        src = _rows(session, product_id)[source]
        copied = {
            k: src[k].value for k in SPREAD_KEYS if k in src and not _empty(src[k].value) and src[k].status != "blocked"
        }
        local_notes = {
            k: (src[k].value_en, src[k].value)
            for k in NOTES
            if k in src and not _empty(src[k].value) and src[k].status != "blocked"
        }
        image = src["image"].value if "image" in src and not _empty(src["image"].value) else None
        facts = _facts(src)

    cost = 0.0
    english: dict[str, list[str]] = {}
    for key, (value_en, value) in local_notes.items():
        if value_en:
            english[key] = [t.strip() for t in str(value_en).split(",") if t.strip()]
        else:
            english[key], usage = normalize_notes(client, str(value))
            cost += usage.cost
    for key, notes in english.items():
        facts[key] = notes
    terms = sorted({t for notes in english.values() for t in notes})
    translations: dict[str, dict[str, str]] = {}
    for language in {group.store(s).language for s in targets if s in group.stores}:
        translations[language], usage = translate_terms(client, terms, language) if terms else ({}, None)
        cost += usage.cost if usage else 0

    done: dict[str, str] = {}
    for store, target in targets.items():
        language = group.store(store).language if store in group.stores else "en"
        with Session(_engine()) as session, session.begin():
            rows = _rows(session, target).get(store, {})
            when = now()
            values = dict(copied)
            values_en = {}
            for key, notes in english.items():
                values[key] = ", ".join(translations.get(language, {}).get(t, t) for t in notes)
                values_en[key] = ", ".join(notes)
            for key, value in values.items():
                row = rows.get(key)
                if row is None or (same(row.value, value) and row.status == "ok"):
                    continue
                if row.previous is None:  # the store's value stays the reference until it goes live
                    row.previous = row.value
                row.value, row.value_en = value, values_en.get(key, row.value_en)
                row.origin, row.status = "input", "ok"
                row.message, row.issues = f"От {source}, изравнено от {actor or 'екипа'}.", []
                row.decided_by, row.decided_at = actor, when
            image_differs = image is not None and "image" in rows and not same(rows["image"].value, image)
            _withdraw_approval(session, target)
        summary, text_cost = write_texts(target, client, force=True, only=[store], facts=facts)
        cost += text_cost
        note = _copy_image(product_id, image, target, actor) if image_differs else None
        done[store] = "изравнен" + (f"; {note}" if note else "")
    return done, round(cost, 4)
