"""„Качи в магазините“: one product, every store it is in or can go to (docs/decisions.md #25).

A store's copy read from that store (its catalog) gets only its changed fields written live (db.live.push); a
copy prepared here (a new product) is created in the store (db.review.publish → db.upload). What waits on a
person (an AI suggestion to accept, a blocked field) is said per store and that store is left out."""

from collections import Counter

from sqlalchemy import select
from sqlalchemy.orm import Session

from db import catalog, live, review
from db.models import FieldRow, Product, StoreProduct
from pipeline.ai import AIError


def _engine():
    from db.repo import engine

    return engine()


_LABELS = {"ean": "EAN", **live.LABELS}


def _waiting(rows: list[FieldRow]) -> str | None:
    counts = Counter(r.status for r in rows if r.status in ("suggested", "blocked"))
    parts = []
    if counts["suggested"]:
        parts.append(
            f"{counts['suggested']} {'предложение' if counts['suggested'] == 1 else 'предложения'} за приемане"
        )
    if counts["blocked"]:
        names = sorted({_LABELS.get(r.key, r.key) for r in rows if r.status == "blocked"})
        parts.append(f"липсва: {', '.join(names)}")
    return " и ".join(parts) or None


def _differs(row: FieldRow) -> bool:
    return row.previous is not None and not live.same(row.value, row.previous)


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
            blocked = any(r.status == "blocked" for r in rows)
            # AI suggestions are accepted by „Качи“ itself (the person picked the store); a blocked field is not.
            suggested = [r for r in rows if r.status == "suggested"]
            item["accept"] = len(suggested)
            if at["kind"] == "audit":
                changed = live._changes(rows)
                changed += [r for r in suggested if r.key in live.LABELS and _differs(r)]
                item["changes"] = [live.LABELS[r.key] for r in changed]
                if changed:
                    item.update(action="update", reason=waiting if blocked else None)
                else:
                    item.update(action="none", reason=waiting or "няма промени")
            elif sp.upload_status == "uploaded":
                item.update(action="none", changes=[], reason="вече е качен")
            elif blocked:
                item.update(action="wait", changes=[], reason=waiting)
            else:
                item.update(action="create", changes=[], reason=None)
            item["message"] = sp.upload_message if sp.upload_status == "failed" else None
            out.append(item)
    # Stores with a template that do not have the product, in its group or in another one with a structure
    # (group 2, 3…): it can be made for them, by their own group's rules (decisions #50).
    from db.stores import list_stores
    from pipeline.config import load_group

    ready: dict[str, bool] = {}
    for s in list_stores():
        if not s["profile_accepted"] or not s["group"] or s["key"] in entry["stores"]:
            continue
        if s["group"] not in ready:
            ready[s["group"]] = load_group(s["group"]).spec is not None
        if ready[s["group"]]:
            out.append(
                {
                    "store": s["key"],
                    "group": s["group"],
                    "product_id": None,
                    "batch_id": None,
                    "kind": None,
                    "action": "missing",
                    "changes": [],
                    "reason": None,
                    "message": None,
                    "accept": 0,
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


def run(product_id: int, stores: list[str], status: str, actor: str | None, client=None) -> dict:
    """Send the product to these stores. Live updates are done when this returns; new products are created by a
    background upload (its state on the product screen). Returns what happened per store and the new plan."""
    current = {s["store"]: s for s in plan(product_id)["stores"]}
    done: dict[str, str] = {}
    create: dict[int, list[str]] = {}
    missing: list[str] = []
    for store in stores:  # the suggestions of a picked store are accepted first (it is what the person sends)
        item = current.get(store)
        if item and item.get("accept") and item["action"] in ("update", "create"):
            review.accept_all(item["product_id"], actor, store)
    current = {s["store"]: s for s in plan(product_id)["stores"]}
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
    if missing:  # made and sent by a background job (make), its state in the dialog
        try:
            job_id = start_align(product_id, missing, status, actor, client)
        except Exception as exc:
            for store in missing:
                done[store] = str(exc)
            return {"done": done, "plan": plan(product_id)}
        for store in missing:
            done[store] = "създава се (около минута на група), после се качва"
        return {"done": done, "plan": plan(product_id), "job_id": job_id}
    return {"done": done, "plan": plan(product_id)}


COPY_KEYS = ("title", "vendor", "gender", "fragrance_family", "top_note", "middle_note", "base_note", "ingredients")


def _from_live(product_id: int, client=None, target_group: str | None = None) -> dict | None:
    """The product's facts from its live copies (pipeline.unify), as saved research, in the vocabulary of the
    group it is made for (its own group by default); None without live copies."""
    from db.models import Batch, Product
    from pipeline.ai import default_client
    from pipeline.config import load_group
    from pipeline.unify import unify_facts

    entry = catalog.entry_for(product_id)
    copies, group = [], None
    with Session(_engine()) as session:
        for store, at in entry["stores"].items():
            if at["kind"] != "audit" or at["state"] == "bad":
                continue
            group = group or load_group(session.get(Batch, session.get(Product, at["product_id"]).batch_id).group_key)
            fields = review._product_rows(session, at["product_id"]).get(store, {})
            cfg = group.stores.get(store)
            handle = str((fields.get("handle") or FieldRow()).value or "")
            shop = (cfg.shop if cfg and cfg.shop not in (None, "CHANGE_ME") else None) or f"{store}.shop"
            copy = {"url": f"https://{shop}/products/{handle}", "language": cfg.language if cfg else None}
            for key in (*COPY_KEYS, "image"):
                row = fields.get(key)
                if row is not None and row.value not in (None, "") and row.status != "blocked":
                    copy[key] = row.value
            copies.append(copy)
    if not copies:
        return None
    raw, _ = unify_facts(client or default_client(), copies, load_group(target_group) if target_group else group)
    # A picture uploaded or replaced here first (the clean original, laid out again on the target store's
    # background); the store pages' pictures after it.
    raw["images"] = _originals(entry) + list(raw.get("images") or [])
    return raw


def _originals(entry: dict) -> list[dict]:
    """The product's original pictures kept on the media disk, the newest first."""
    from db.models import Media

    ids = [at["product_id"] for at in entry["stores"].values()]
    with Session(_engine()) as session:
        rows = session.execute(
            select(Media).where(Media.product_id.in_(ids), Media.kind == "original").order_by(Media.id.desc())
        ).scalars()
        return [
            {"url": f"media:{m.path}", "width": m.width, "height": m.height, "source": "снимка от приложението"}
            for m in rows
        ]


def make(product_id: int, stores: list[str], status: str, actor: str | None, client, job: dict) -> dict[str, str]:
    """Stores without the product (its group or group 2, 3…): made like a quick new product, its facts from the
    live copies (no new web research when there are any) read into each target group's vocabulary, each store's
    text by its template, the price from the euro price; then sent, as the person picked these stores (their
    suggestions accepted; a blocked field keeps that store back). One group at a time; runs in `job`'s thread.
    Returns what happened per store (decisions #50)."""
    import time

    from db import newbatch
    from db.models import Product
    from db.stores import list_stores

    whole = plan(product_id)
    price, compare = _euro_price(product_id)
    ean, sku = _codes(product_id)
    item = {"name": whole["title"], "ean": ean or whole["ean"] or "", "price": price, "compare": compare}
    group_of = {s["key"]: s["group"] for s in list_stores()}
    by_group: dict[str, list[str]] = {}
    for store in stores:
        by_group.setdefault(group_of.get(store) or "", []).append(store)
    out: dict[str, str] = {}
    for group_key, keys in by_group.items():
        job.update(stage="research", stage_label=f"Създавам продукта в {len(keys)} магазина ({group_key})")
        try:
            try:
                research = _from_live(product_id, client, group_key or None)
            except AIError:  # the live copies could not be read together: researched like a new product
                research = None
            made = newbatch.quick_start([item], keys, actor, client=client, research=research, besides=job["id"])
            while newbatch.job(made)["running"]:
                time.sleep(1)
            result = newbatch.job(made)
            if result["error"] or not result["batch_id"]:
                raise newbatch.NewBatchError(result["error"] or "продуктът не се създаде")
            with Session(_engine()) as session:
                new_id = session.execute(
                    select(Product.id).where(Product.batch_id == result["batch_id"]).order_by(Product.id)
                ).scalar()
            if sku:
                _keep_sku(new_id, sku, actor)
            for key in keys:
                review.accept_all(new_id, actor, key)
            try:
                sent = review.publish(new_id, keys, status, actor)
            except review.ReviewError:  # no store is ready: each one's missing fields are said below
                sent = {"stores": [], "skipped": {}}
            missing = _blocked(new_id)
            for key in keys:
                if key in sent["stores"]:
                    out[key] = "създаден, качва се в магазина…"
                else:
                    why = missing.get(key) or sent["skipped"].get(key) or "преглед"
                    out[key] = f"създаден, но не е качен; липсва: {why}. Отвори го, допълни и го качи."
        except Exception as exc:  # one group failing does not stop the next
            message = (
                str(exc)
                if isinstance(exc, (newbatch.NewBatchError, review.ReviewError, AIError))
                else (f"{type(exc).__name__}: {exc}")
            )
            for key in keys:
                out[key] = f"не се създаде: {message}"
    return out


def _codes(product_id: int) -> tuple[str, str]:
    """The EAN and the SKU to carry over, never made up (decisions #32). The SKU is the open copy's (the team's
    code). The EAN is a valid barcode: the open copy's when it is one, else the one most of the product's other
    copies have (a placeholder like 5901234000005 in one store does not travel)."""
    from collections import Counter

    from pipeline import ean as ean_check

    def valid(value) -> str:
        code = str(value or "").strip()
        return code if code.isdigit() and not ean_check.problem(code) else ""

    entry = catalog.entry_for(product_id)
    with Session(_engine()) as session:
        own = {}
        seen: Counter = Counter()
        for store, at in entry["stores"].items():
            fields = review._product_rows(session, at["product_id"]).get(store, {})
            if at["product_id"] == product_id:
                own = fields
            row = fields.get("ean")
            for value in (row.value, row.previous) if row is not None else ():
                if valid(value):
                    seen[valid(value)] += 1
                    break
            product = session.get(Product, at["product_id"])
            if row is None and product is not None and valid(product.ean):
                seen[valid(product.ean)] += 1

    def text(key: str) -> str:
        row = own.get(key)
        return str(row.value).strip() if row is not None and row.value not in (None, "") else ""

    ean = valid(text("ean")) or (seen.most_common(1)[0][0] if seen else "")
    return ean, text("sku")


def _keep_sku(product_id: int, sku: str, actor: str | None) -> None:
    """The SKU of the copy it was made from, in every store of the new product (one edit reaches them all)."""
    with Session(_engine()) as session:
        rows = review._product_rows(session, product_id)
        ids = [r["sku"].id for r in rows.values() if r.get("sku") is not None and str(r["sku"].value) != sku]
    for field_id in ids:  # one edit reaches every store with the same SKU; a store with its own gets its edit
        review.decide(field_id, "edit", actor, sku)


def _blocked(product_id: int) -> dict[str, str]:
    """Per store, the fields that keep the product back, by name and why („Снимка (Продуктът няма снимка.)“)."""
    labels = _LABELS
    out: dict[str, list[str]] = {}
    with Session(_engine()) as session:
        for store, fields in review._product_rows(session, product_id).items():
            for key, row in fields.items():
                if row.status == "blocked":
                    out.setdefault(store, []).append(f"{labels.get(key, key)} ({(row.message or '').strip()})")
    return {k: "; ".join(v) for k, v in out.items()}


def start_align(product_id: int, stores: list[str], status: str, actor: str | None, client=None) -> str:
    """„Изравни и качи“ as a background job: the open copy's facts, translated notes, texts in each store's
    template and picture go to the chosen stores' copies (db.fill.spread_entry), then everything is sent
    (run). Stores without the product are then made and sent in the same job (make)."""
    import threading
    import time
    import uuid

    from db import newbatch
    from pipeline.ai import api_key

    if not api_key() and client is None:
        raise newbatch.NewBatchError("Няма ключ за Claude (ANTHROPIC_API_KEY в Render → Environment).")
    current = {s["store"]: s for s in plan(product_id)["stores"]}
    existing = [s for s in stores if s in current and current[s]["action"] != "missing"]
    missing = [s for s in stores if s in current and current[s]["action"] == "missing"]
    with newbatch._lock:
        newbatch.busy()
        job_id = uuid.uuid4().hex[:12]
        newbatch._jobs[job_id] = {
            "id": job_id,
            "kind": "fill",
            "running": True,
            "stage": "texts",
            "stage_label": (
                f"Изравнявам {len(existing)} магазина (превод, описания, снимка)"
                if existing
                else f"Създавам продукта в {len(missing)} магазина"
            ),
            "done": 0,
            "total": len(stores),
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
        from db import fill
        from pipeline.ai import default_client

        result: dict[str, str] = {}
        try:
            ai = client or default_client()
            if existing:
                aligned, cost = fill.spread_entry(product_id, existing, actor, ai)
                job.update(stage="saving", stage_label="Качвам в магазините", cost_usd=cost)
                sent = run(product_id, existing, status, actor)["done"]
                for store in existing:
                    parts = [p for p in (aligned.get(store), sent.get(store)) if p]
                    result[store] = " · ".join(parts) or "няма какво да се качи"
                job.update(result=dict(result), done=len(existing))
            if missing:
                result.update(make(product_id, missing, status, actor, ai, job))
        except Exception as exc:
            job["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            job.update(result=result, running=False, finished_at=time.time(), done=len(stores))

    threading.Thread(target=work, daemon=True, name=f"align-{job_id}").start()
    return job_id
