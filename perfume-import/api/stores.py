"""Stores, catalog uploads and profiles (SPEC §8.7). Tokens are never sent here: only env var names."""

from typing import Annotated

from fastapi import APIRouter, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel

from api.review import actor_name
from db import stores

router = APIRouter(prefix="/api")
MAX_UPLOAD = 60_000_000


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except KeyError as exc:
        raise HTTPException(404, str(exc.args[0]) if exc.args else "Не е намерено.") from exc
    except stores.StoreError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/stores")
def list_stores():
    return stores.list_stores()


@router.post("/stores/analyze", status_code=201)
async def analyze(
    file: Annotated[UploadFile, File()],
    name: Annotated[str, Form()] = "",
    shop: Annotated[str, Form()] = "",
    country: Annotated[str, Form()] = "",
    language: Annotated[str, Form()] = "",
    currency: Annotated[str, Form()] = "",
    group: Annotated[str, Form()] = "",
    store: Annotated[str, Form()] = "",
    x_actor: str | None = Header(default=None),
):
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "Файлът е по-голям от 60 MB.")
    profile_id = _call(
        stores.analyze,
        data,
        file.filename or "export.csv",
        name=name,
        shop=shop or None,
        country=country or None,
        language=language or None,
        currency=currency or None,
        group_key=group or None,
        store_key=store or None,
        actor=actor_name(x_actor),
    )
    return {"profile_id": profile_id}


@router.get("/profiles/{profile_id}")
def profile(profile_id: int):
    return _call(stores.get_profile, profile_id)


class ItemEdit(BaseModel):
    value: object


@router.put("/profiles/{profile_id}/items/{key}")
def edit_item(profile_id: int, key: str, body: ItemEdit, x_actor: str | None = Header(default=None)):
    return _call(stores.update_item, profile_id, key, body.value, actor_name(x_actor))


class Accept(BaseModel):
    group: str | None = None


@router.post("/profiles/{profile_id}/accept")
def accept(profile_id: int, body: Accept, x_actor: str | None = Header(default=None)):
    return _call(stores.accept, profile_id, body.group, actor_name(x_actor))


@router.post("/profiles/{profile_id}/reject")
def reject(profile_id: int, x_actor: str | None = Header(default=None)):
    return _call(stores.reject, profile_id, actor_name(x_actor))


class Shop(BaseModel):
    shop: str


@router.put("/stores/{store_key}/shop")
def set_shop(store_key: str, body: Shop, x_actor: str | None = Header(default=None)):
    _call(stores.set_shop, store_key, body.shop, actor_name(x_actor))
    return {"ok": True}
