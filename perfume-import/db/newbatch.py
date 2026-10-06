"""A new batch started from the app (SPEC §1 step 2, NewBatch.dc.html): check the input and the expected cost
for free, then research, texts, pictures and fields run on the server in a background thread, so the pictures
land on the server's disk and the batch in its database. Paid: started only by an explicit request after the
estimate was shown. One run at a time.
"""

import threading
import uuid
from datetime import date

from db.stores import accepted_profiles, install
from pipeline.ai import api_key
from pipeline.config import load_group
from pipeline.estimate import estimate
from pipeline.input import InputError, InputRow, read_input_text
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


def _rows(text: str, group_key: str, stores: list[str]) -> tuple[object, list[InputRow]]:
    install()
    group = load_group(group_key)
    if group.spec is None:
        raise NewBatchError(f"Група „{group_key}“ още няма структура (group.yaml); създай я с /new-group.")
    stores = stores or list(group.stores)
    unknown = [s for s in stores if s not in group.stores]
    if unknown:
        raise NewBatchError(f"Магазините {', '.join(unknown)} не са в {group_key}.")
    try:
        return group, read_input_text(text, group, stores)
    except InputError as exc:
        raise NewBatchError(str(exc)) from exc


def _measured() -> dict:
    from db.repo import measured_costs

    try:
        return {name: measured_costs(name) for name in TIERS}
    except Exception:  # an empty database: defaults
        return {}


def check(text: str, group_key: str, stores: list[str], tier: str = "economy", deep: list[str] | None = None) -> dict:
    """Free: every row with its problems, and the expected cost of the rows that will run."""
    if tier not in TIERS:
        raise NewBatchError(f"Непознат режим „{tier}“.")
    group, rows = _rows(text, group_key, stores)
    stores = stores or list(group.stores)
    good = [r for r in rows if not r.problems]
    est = estimate(good, group, stores, tier, set(deep or []), _measured())
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
) -> str:
    """Run the batch in a background thread; returns the job id. Rows with problems are left out."""
    if not api_key() and client is None:
        raise NewBatchError(
            "Няма ключ за Claude. Добави ANTHROPIC_API_KEY в Render → perfume-import → Environment и опитай отново."
        )
    group, rows = _rows(text, group_key, stores)
    stores = stores or list(group.stores)
    rows = [r for r in rows if not r.problems]
    if not rows:
        raise NewBatchError("Няма нито един ред без грешка.")
    with _lock:
        if any(j["running"] for j in _jobs.values()):
            raise NewBatchError("Вече върви една нова партида; изчакай да свърши.")
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
                saved_research=find_research,
                default_tier=tier,
                deep_eans=set(deep or []),
                profiles=accepted_profiles(stores),
                progress=progress,
            )
            progress("saving", 0, 1)
            batch_id = save_batch(result, author=actor)
            _jobs[job_id].update({"batch_id": batch_id, "cost_usd": result.cost_usd})
        except Exception as exc:  # shown in the app; nothing is saved half-way (save_batch is one transaction)
            _jobs[job_id]["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            _jobs[job_id]["running"] = False

    threading.Thread(target=work, daemon=True, name=f"new-batch-{job_id}").start()
    return job_id


def job(job_id: str) -> dict:
    if job_id not in _jobs:
        raise KeyError("Няма такава задача (сървърът може да е рестартиран).")
    return dict(_jobs[job_id])


def running() -> dict | None:
    return next((dict(j) for j in _jobs.values() if j["running"]), None)
