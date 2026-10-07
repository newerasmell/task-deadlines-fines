"""Review endpoints for the app (SPEC §8). The person deciding is the logged-in user (api.auth); the X-Actor
header (URL-encoded name) is used only where there is no login, i.e. in tests and scripts."""

from typing import Annotated
from urllib.parse import unquote

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel

from api.auth import current_user
from db import audit, review, upload
from pipeline.config import load_group

router = APIRouter(prefix="/api")


def actor_name(x_actor: str | None) -> str | None:
    if user := current_user.get():
        return user["name"]
    return unquote(x_actor).strip() or None if x_actor else None


def _call(fn, *args):
    try:
        return fn(*args)
    except KeyError as exc:
        raise HTTPException(404, str(exc.args[0]) if exc.args else "Не е намерено.") from exc
    except review.ReviewError as exc:
        raise HTTPException(409, str(exc)) from exc


class Decision(BaseModel):
    action: str  # accept | edit | pick
    value: object | None = None


class StoreScope(BaseModel):
    store: str | None = None


class Column(BaseModel):
    store: str
    key: str


@router.get("/batches")
def batches():
    return review.list_batches()


@router.get("/batches/{batch_id}")
def batch(batch_id: int):
    return _call(review.get_batch, batch_id)


@router.get("/products/{product_id}")
def product(product_id: int):
    return _call(review.get_product, product_id)


@router.get("/products/{product_id}/research")
def research(product_id: int):
    return _call(review.get_research, product_id)


@router.post("/fields/{field_id}/decision")
def decide(field_id: int, body: Decision, x_actor: str | None = Header(default=None)):
    return _call(review.decide, field_id, body.action, actor_name(x_actor), body.value)


@router.post("/products/{product_id}/accept-all")
def accept_all(product_id: int, body: StoreScope, x_actor: str | None = Header(default=None)):
    return _call(review.accept_all, product_id, actor_name(x_actor), body.store)


class Publish(BaseModel):
    stores: list[str] | None = None  # None: every store of the product that is ready
    status: str = "draft"


@router.post("/products/{product_id}/publish", status_code=202)
def publish(product_id: int, body: Publish, x_actor: str | None = Header(default=None)):
    """Approve and upload one product, per store: the ready ones go, the others are listed with why."""
    return _call(review.publish, product_id, body.stores, body.status, actor_name(x_actor))


@router.post("/products/{product_id}/approve")
def approve(product_id: int, x_actor: str | None = Header(default=None)):
    return _call(review.approve, product_id, actor_name(x_actor))


@router.post("/batches/{batch_id}/accept-column")
def accept_column(batch_id: int, body: Column, x_actor: str | None = Header(default=None)):
    return {"accepted": _call(review.accept_column, batch_id, body.store, body.key, actor_name(x_actor))}


@router.get("/groups/{group_key}/vocab")
def vocab(group_key: str):
    try:
        group = load_group(group_key)
    except FileNotFoundError as exc:
        raise HTTPException(404, f"Няма група „{group_key}“.") from exc
    return {key: list(values) for key, values in group.vocab.items()}


class UploadRequest(BaseModel):
    status: str = "draft"  # draft | active
    stores: list[str] | None = None
    only_failed: bool = False


@router.post("/batches/{batch_id}/upload", status_code=202)
def start_upload(batch_id: int, body: UploadRequest, x_actor: str | None = Header(default=None)):
    if body.status not in upload.STATUSES:
        raise HTTPException(422, "Статусът е draft или active.")
    state = _call(upload.state, batch_id)
    if state["kind"] != "new":
        raise HTTPException(409, "Качват се само партиди с нови продукти.")
    started = upload.start(
        batch_id, status=body.status, stores=body.stores, only_failed=body.only_failed, actor=actor_name(x_actor)
    )
    if not started:
        raise HTTPException(409, "Качването на тази партида вече върви.")
    return {"started": True}


@router.get("/batches/{batch_id}/upload")
def upload_state(batch_id: int):
    return _call(upload.state, batch_id)


@router.get("/batches/{batch_id}/audit")
def audit_summary(batch_id: int):
    return _call(audit.summary, batch_id)


@router.get("/batches/{batch_id}/audit/{rule}")
def audit_items(batch_id: int, rule: str, offset: int = 0, limit: int = 50):
    return _call(audit.items, batch_id, rule, offset, min(limit, 5000))


@router.get("/batches/{batch_id}/fix.csv")
def audit_fix_csv(batch_id: int):
    from fastapi.responses import Response

    filename, data = _call(audit.fix_csv, batch_id)
    return Response(
        data,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/products/{product_id}/image")
async def replace_image(
    product_id: int,
    url: Annotated[str, Form()] = "",
    file: Annotated[UploadFile | None, File()] = None,
    x_actor: str | None = Header(default=None),
):
    """A correct picture by link or upload: the new original, composed for every store by its layout."""
    from starlette.concurrency import run_in_threadpool

    from db import images

    actor = actor_name(x_actor)
    try:
        if file is not None:
            data = await file.read(images.MAX_UPLOAD + 1)
            source = file.filename or "качен файл"
        elif url.strip():
            data = await run_in_threadpool(images.from_url, url)
            source = url.strip()
        else:
            raise HTTPException(422, "Постави линк към снимката или качи файл.")
        return await run_in_threadpool(images.replace, product_id, data, source, actor)
    except images.ImageError as exc:
        raise HTTPException(422, str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(404, str(exc.args[0])) from exc
