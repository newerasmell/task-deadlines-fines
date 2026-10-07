"""New batch from the app (NewBatch.dc.html): input check and cost estimate (free), start (paid), progress."""

import csv
import io
from typing import Annotated

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from api.review import actor_name
from db import newbatch
from pipeline.config import input_template_columns, list_groups, load_group

router = APIRouter(prefix="/api")
MAX_INPUT = 5_000_000


async def _text(file: UploadFile | None, text: str) -> str:
    if file is not None:
        data = await file.read(MAX_INPUT + 1)
        if len(data) > MAX_INPUT:
            raise HTTPException(413, "Файлът е по-голям от 5 MB.")
        try:
            return data.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise HTTPException(422, "Файлът не е в UTF-8. Запази го от Excel като „CSV UTF-8“.") from exc
    if not text.strip():
        raise HTTPException(422, "Качи CSV или постави редовете от Excel.")
    return text


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except KeyError as exc:
        raise HTTPException(404, str(exc.args[0]) if exc.args else "Не е намерено.") from exc
    except newbatch.NewBatchError as exc:
        raise HTTPException(409, str(exc)) from exc


def _list(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


@router.get("/groups")
def groups():
    out = []
    for key in list_groups():
        group = load_group(key)
        out.append(
            {
                "key": key,
                "name": group.spec.name if group.spec else key,
                "ready": group.spec is not None,
                "stores": [
                    {
                        "key": s.key,
                        "label": s.label,
                        "country": s.country,
                        "language": s.language,
                        "currency": s.currency,
                    }
                    for s in group.stores.values()
                ],
            }
        )
    return out


@router.get("/groups/{group_key}/input-template.csv")
def input_template(group_key: str):
    try:
        group = load_group(group_key)
    except FileNotFoundError as exc:
        raise HTTPException(404, f"Няма група „{group_key}“.") from exc
    buf = io.StringIO()
    csv.writer(buf, lineterminator="\n").writerow(input_template_columns(group))
    headers = {"Content-Disposition": f'attachment; filename="products-{group_key}.csv"'}
    return Response(buf.getvalue().encode("utf-8"), media_type="text/csv; charset=utf-8", headers=headers)


@router.post("/batches/check")
async def check(
    group: Annotated[str, Form()],
    stores: Annotated[str, Form()] = "",
    tier: Annotated[str, Form()] = "economy",
    deep: Annotated[str, Form()] = "",
    text: Annotated[str, Form()] = "",
    mode: Annotated[str, Form()] = "table",
    fast: Annotated[bool, Form()] = False,
    file: Annotated[UploadFile | None, File()] = None,
):
    return _call(newbatch.check, await _text(file, text), group, _list(stores), tier, _list(deep), mode, fast)


@router.post("/batches/start", status_code=202)
async def start(
    group: Annotated[str, Form()],
    stores: Annotated[str, Form()] = "",
    tier: Annotated[str, Form()] = "economy",
    deep: Annotated[str, Form()] = "",
    name: Annotated[str, Form()] = "",
    text: Annotated[str, Form()] = "",
    mode: Annotated[str, Form()] = "table",
    fast: Annotated[bool, Form()] = False,
    file: Annotated[UploadFile | None, File()] = None,
    x_actor: str | None = Header(default=None),
):
    job_id = _call(
        newbatch.start,
        await _text(file, text),
        group,
        _list(stores),
        tier,
        _list(deep),
        name or None,
        actor_name(x_actor),
        mode=mode,
        fast=fast,
    )
    return {"job_id": job_id}


@router.get("/jobs/running")
def running_job():
    return newbatch.running()


@router.get("/jobs/latest")
def latest_job():
    return newbatch.latest()


@router.get("/jobs/{job_id}")
def job(job_id: str):
    return _call(newbatch.job, job_id)


@router.get("/batches/{batch_id}/stores/options")
def store_options(batch_id: int):
    """Stores that can still be added to a batch, and what it costs (texts only: research is reused)."""
    from db import extend

    return _call(extend.options, batch_id)


class AddStores(BaseModel):
    stores: list[str]
    fast: bool = True


@router.post("/batches/{batch_id}/stores", status_code=202)
def add_stores(batch_id: int, body: AddStores, x_actor: str | None = Header(default=None)):
    from db import extend

    return {"job_id": _call(extend.start, batch_id, body.stores, actor_name(x_actor), body.fast)}


@router.get("/products/{product_id}/missing")
def product_missing(product_id: int):
    """The product's empty or blocked facts that „Попълни липсващото“ can fill."""
    from db import fill

    return _call(fill.missing, product_id)


class Fill(BaseModel):
    url: str | None = None


@router.post("/products/{product_id}/fill", status_code=202)
def fill_missing(product_id: int, body: Fill, x_actor: str | None = Header(default=None)):
    """Only the missing facts, from a linked page (one fetch) or a short search; suggestions for every store."""
    from db import fill

    return {"job_id": _call(fill.start, product_id, (body.url or "").strip() or None, actor_name(x_actor))}


class Notes(BaseModel):
    text: str


@router.post("/fields/{field_id}/sync-notes")
def sync_notes(field_id: int, body: Notes, x_actor: str | None = Header(default=None)):
    """Notes typed or pasted by a person -> English names -> every store of the product in its language."""
    from db import fill

    return _call(fill.sync_notes, field_id, body.text, actor_name(x_actor))
