"""New batch from the app (NewBatch.dc.html): input check and cost estimate (free), start (paid), progress."""

import csv
import io
from typing import Annotated

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response

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
    file: Annotated[UploadFile | None, File()] = None,
):
    return _call(newbatch.check, await _text(file, text), group, _list(stores), tier, _list(deep))


@router.post("/batches/start", status_code=202)
async def start(
    group: Annotated[str, Form()],
    stores: Annotated[str, Form()] = "",
    tier: Annotated[str, Form()] = "economy",
    deep: Annotated[str, Form()] = "",
    name: Annotated[str, Form()] = "",
    text: Annotated[str, Form()] = "",
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
    )
    return {"job_id": job_id}


@router.get("/jobs/running")
def running_job():
    return newbatch.running()


@router.get("/jobs/{job_id}")
def job(job_id: str):
    return _call(newbatch.job, job_id)
