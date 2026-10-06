"""Review endpoints for the app (SPEC §8). The person deciding comes from the X-Actor header (URL-encoded
name, kept in the browser) until the team login is connected."""

from urllib.parse import unquote

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from db import audit, review, upload
from pipeline.config import load_group

router = APIRouter(prefix="/api")


def actor_name(x_actor: str | None) -> str | None:
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
