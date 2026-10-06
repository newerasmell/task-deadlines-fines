"""Review endpoints for the app (SPEC §8). The person deciding comes from the X-Actor header (URL-encoded
name, kept in the browser) until the team login is connected."""

from urllib.parse import unquote

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from db import review
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
