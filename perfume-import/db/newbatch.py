"""A new batch started from the app (SPEC §1 step 2, NewBatch.dc.html): check the input and the expected cost
for free, then research, texts, pictures and fields run on the server in a background thread, so the pictures
land on the server's disk and the batch in its database. Paid: started only by an explicit request after the
estimate was shown. One run at a time.
"""

import threading
import time
import uuid
from datetime import date

from db.stores import accepted_profiles, install
from pipeline.ai import api_key
from pipeline.config import load_group
from pipeline.estimate import estimate
from pipeline.input import InputError, InputRow, read_input_text, read_names_text
from pipeline.tiers import TIERS

_jobs: dict[str, dict] = {}
_lock = threading.Lock()
STAGES = {
    "research": "Проучване",
    "images": "Снимки",
    "texts": "Описания и нотки",
    "fields": "Полета",
    "saving": "Запис",
}


class NewBatchError(Exception):
    """Something the person can fix; Bulgarian message."""


def busy(sync: bool = False) -> None:
    """One AI job at a time, and one read of the stores at a time; the two run side by side, so a long Shopify
    read never blocks filling a product (and the other way round). Call under _lock."""
    for j in _jobs.values():
        if j["running"] and (j.get("kind") == "sync") == sync:
            if sync:
                raise NewBatchError("Магазините вече се изтеглят от Shopify; изчакай да свърши.")
            raise NewBatchError(f"Вече върви AI задача ({j.get('stage_label') or 'работа'}); изчакай да свърши.")


def _rows(text: str, group_key: str, stores: list[str], mode: str = "table") -> tuple[object, list[InputRow]]:
    install()
    group = load_group(group_key)
    if group.spec is None:
        raise NewBatchError(f"Група „{group_key}“ още няма структура (group.yaml); създай я с /new-group.")
    stores = stores or list(group.stores)
    unknown = [s for s in stores if s not in group.stores]
    if unknown:
        raise NewBatchError(f"Магазините {', '.join(unknown)} не са в {group_key}.")
    try:
        reader = read_names_text if mode == "names" else read_input_text
        return group, reader(text, group, stores)
    except InputError as exc:
        raise NewBatchError(str(exc)) from exc


def _measured() -> dict:
    from db.repo import measured_costs

    try:
        return {name: measured_costs(name) for name in TIERS}
    except Exception:  # an empty database: defaults
        return {}


def _styled(group, stores: list[str]) -> set[str]:
    """Stores that will write their own text (an accepted profile with example descriptions)."""
    from pipeline.generate import store_style

    profiles = accepted_profiles(stores)
    return {s for s in stores if store_style(group.store(s), profiles.get(s), group)}


def check(
    text: str,
    group_key: str,
    stores: list[str],
    tier: str = "economy",
    deep: list[str] | None = None,
    mode: str = "table",
    fast: bool = False,
) -> dict:
    """Free: every row with its problems, and the expected cost of the rows that will run.

    fast: texts as direct calls in parallel (minutes) instead of the Batches API queue (half price, can take
    up to an hour)."""
    if tier not in TIERS:
        raise NewBatchError(f"Непознат режим „{tier}“.")
    group, rows = _rows(text, group_key, stores, mode)
    stores = stores or list(group.stores)
    good = [r for r in rows if not r.problems]
    est = estimate(
        good, group, stores, tier, set(deep or []), _measured(), no_batch=fast, styled=_styled(group, stores)
    )
    return {
        "rows": [
            {
                "line": r.line,
                "name": r.name,
                "ml": r.ml,
                "tester": r.tester,
                "ean": r.ean,
                "prices": r.prices,
                "tier": r.tier,
                "problems": r.problems,
            }
            for r in rows
        ],
        "ready": len(good),
        "estimate": est.to_dict(),
        "api_key": bool(api_key()),
    }


def start(
    text: str,
    group_key: str,
    stores: list[str],
    tier: str = "economy",
    deep: list[str] | None = None,
    name: str | None = None,
    actor: str | None = None,
    client=None,
    mode: str = "table",
    fast: bool = False,
    after=None,
    research: dict | None = None,
) -> str:
    """Run the batch in a background thread; returns the job id. Rows with problems are left out.
    after(batch_id): runs once the batch is saved (the quick new product sets its prices there)."""
    if not api_key() and client is None:
        raise NewBatchError(
            "Няма ключ за Claude. Добави ANTHROPIC_API_KEY в Render → perfume-import → Environment и опитай отново."
        )
    group, rows = _rows(text, group_key, stores, mode)
    stores = stores or list(group.stores)
    rows = [r for r in rows if not r.problems]
    if not rows:
        raise NewBatchError("Няма нито един ред без грешка.")
    with _lock:
        busy()
        job_id = uuid.uuid4().hex[:12]
        _jobs[job_id] = {
            "id": job_id,
            "running": True,
            "stage": "research",
            "stage_label": STAGES["research"],
            "done": 0,
            "total": len(rows),
            "error": None,
            "batch_id": None,
            "cost_usd": None,
            "fast": fast,
            "started_at": time.time(),
            "finished_at": None,
        }
    batch_name = name or f"{date.today().isoformat()} · {len(rows)} продукта"

    def progress(stage: str, done: int, total: int) -> None:
        _jobs[job_id].update({"stage": stage, "stage_label": STAGES.get(stage, stage), "done": done, "total": total})

    def work() -> None:
        from db.repo import find_research, save_batch
        from pipeline.ai import default_client
        from pipeline.batch import run_batch

        try:
            result = run_batch(
                client or default_client(),
                rows,
                group,
                stores,
                batch_name,
                saved_research=(lambda ean: research) if research else find_research,
                default_tier=tier,
                deep_eans=set(deep or []),
                profiles=accepted_profiles(stores),
                progress=progress,
                batch_texts=False if fast else None,
            )
            progress("saving", 0, 1)
            batch_id = save_batch(result, author=actor)
            _jobs[job_id].update({"batch_id": batch_id, "cost_usd": result.cost_usd})
            if after and (note := after(batch_id)):
                _jobs[job_id]["result"] = note
        except Exception as exc:  # shown in the app; nothing is saved half-way (save_batch is one transaction)
            _jobs[job_id]["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            _jobs[job_id].update({"running": False, "finished_at": time.time()})

    threading.Thread(target=work, daemon=True, name=f"new-batch-{job_id}").start()
    return job_id


def job(job_id: str) -> dict:
    if job_id not in _jobs:
        raise KeyError("Няма такава задача (сървърът може да е рестартиран).")
    return dict(_jobs[job_id])


def running() -> dict | None:
    return next((dict(j) for j in _jobs.values() if j["running"]), None)


def latest() -> dict | None:
    """The running job, else the last one this server ran (finished or failed); None after a restart."""
    current = running()
    if current:
        return current
    return dict(list(_jobs.values())[-1]) if _jobs else None


# ---- the quick new product (docs/decisions.md #22) ---------------------------------------------------------


def _quick_rows(items: list[dict]) -> tuple[str, dict[int, tuple[float | None, float | None]]]:
    """One line per product for the names reader („Dior Sauvage EDT 100 ml TESTER 3348901250146“), and the
    euro prices by line."""
    lines, prices = [], {}
    for item in items:
        name = " ".join(str(item.get("name") or "").split())
        if not name:
            continue
        lines.append(f"{name} {str(item.get('ean') or '').strip()}".strip())
        prices[len(lines)] = (_euros(item.get("price")), _euros(item.get("compare")))
    if not lines:
        raise NewBatchError("Напиши поне един продукт: марка, име, концентрация и обем.")
    return "\n".join(lines), prices


def _euros(value) -> float | None:
    if value in (None, ""):
        return None
    try:
        amount = float(str(value).replace(" ", "").replace(",", "."))
    except ValueError as exc:
        raise NewBatchError(f"„{value}“ не е цена; напиши я с цифри, напр. 69,00.") from exc
    if amount <= 0:
        raise NewBatchError("Цената трябва да е над нула.")
    return amount


def _group_of(stores: list[str]) -> str:
    from db.stores import list_stores

    known = {s["key"]: s["group"] for s in list_stores()}
    groups = {known.get(s) for s in stores}
    if not stores or None in groups:
        raise NewBatchError("Избери поне един магазин.")
    if len(groups) > 1:
        raise NewBatchError("Избери магазини от една група; за другата група създай продукта отделно.")
    return groups.pop()


def quick_check(items: list[dict], stores: list[str]) -> dict:
    """Free: each product as it will be read (volume, tester, EAN), what is missing, the expected cost, and the
    stores where a product with this EAN already is."""
    from db.catalog import catalog

    text, prices = _quick_rows(items)
    result = check(text, _group_of(stores), stores, mode="names", fast=True)
    for row in result["rows"]:
        price, compare = prices.get(row["line"], (None, None))
        row["price_eur"], row["compare_eur"] = price, compare
        row["exists"] = []
        if row["ean"]:
            found = [e for e in catalog(q=row["ean"], limit=5)["items"] if e["ean"] == row["ean"]]
            if found:
                row["exists"] = sorted(found[0]["stores"])
                row["exists_at"] = {"batch_id": found[0]["batch_id"], "product_id": found[0]["product_id"]}
        if compare is not None and price is not None and compare <= price:
            row["problems"].append("Старата цена трябва да е по-висока от цената.")
    return result


def quick_start(
    items: list[dict], stores: list[str], actor: str | None, client=None, research: dict | None = None
) -> str:
    """Research, texts per store, pictures and fields like a new batch (fast texts), then each product gets its
    prices in every store's currency from the euro price (ECB rate, the store's rounding)."""
    text, prices = _quick_rows(items)
    for price, compare in prices.values():
        if compare is not None and price is not None and compare <= price:
            raise NewBatchError("Старата цена трябва да е по-висока от цената.")

    def set_prices(batch_id: int) -> dict | None:
        from sqlalchemy import select
        from sqlalchemy.orm import Session

        from db import review
        from db.models import Product

        with Session(review._engine()) as session:
            products = session.execute(select(Product.id, Product.input).where(Product.batch_id == batch_id)).all()
        problems = []
        for product_id, row in products:
            price, compare = prices.get(row.get("line"), (None, None))
            if price is None:
                continue
            try:  # the product is saved either way; a price that could not be set is entered on its screen
                plan = review.price_plan(product_id, price, compare)["stores"]
                review.set_prices(
                    product_id,
                    {k: {"price": v["price"], "compare_at": v["compare_at"]} for k, v in plan.items() if "price" in v},
                    actor,
                )
            except Exception as exc:
                problems.append(f"{row.get('name')}: {exc}")
        return {"Цени": "; ".join(problems)} if problems else None

    name = f"{date.today().isoformat()} · {len(prices)} {'продукт' if len(prices) == 1 else 'продукта'}"
    return start(
        text, _group_of(stores), stores, name=name, actor=actor, client=client, mode="names", fast=True,
        after=set_prices, research=research,
    )  # fmt: skip
