"""Stores, catalog uploads and profiles (SPEC §8.7). Shopify access is write-only: stored encrypted, never sent back."""

from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel

from api.auth import require_admin
from api.review import actor_name
from db import connect, groups, newbatch, stores, sync

router = APIRouter(prefix="/api")
MAX_UPLOAD = 60_000_000


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except KeyError as exc:
        raise HTTPException(404, str(exc.args[0]) if exc.args else "Не е намерено.") from exc
    except (stores.StoreError, sync.SyncError, newbatch.NewBatchError, groups.GroupError) as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/stores")
def list_stores():
    return stores.list_stores()


class Sync(BaseModel):
    stores: list[str] | None = None  # None: every store with a template and Shopify access


@router.post("/stores/sync", status_code=202)
def sync_stores(body: Sync, x_actor: str | None = Header(default=None)):
    """Read the products of these stores live from Shopify (a background job, see /api/jobs/latest)."""
    keys = body.stores if body.stores is not None else sync.ready_stores()
    return {"job_id": _call(sync.start, keys, actor_name(x_actor))}


class Connect(BaseModel):
    store: str | None = None  # an existing store; else a new one from name
    name: str = ""
    group: str | None = None
    shop: str = ""
    country: str = ""
    language: str = ""
    currency: str = ""
    client_id: str = ""
    client_secret: str = ""
    token: str = ""


@router.post("/stores/connect", status_code=202, dependencies=[Depends(require_admin)])
def connect_store(body: Connect, x_actor: str | None = Header(default=None)):
    """„Свържи магазин“: address and access saved and checked, then the products are read from Shopify and the
    store's template is learned from them (a background job; its result names the proposed template)."""
    actor = actor_name(x_actor)
    key, group = _call(
        connect.prepare, body.store, body.name, body.group, body.shop, body.country, body.language,
        body.currency, body.client_id, body.client_secret, body.token, actor,
    )  # fmt: skip
    return {"job_id": _call(connect.start, key, group, actor), "store": key}


class NewGroup(BaseModel):
    name: str = ""


@router.post("/groups", status_code=201, dependencies=[Depends(require_admin)])
def create_group(body: NewGroup):
    """A new group (group 3 and on); its stores are connected into it and its structure learned from them."""
    key = _call(groups.create, body.name)
    return {"key": key, "name": groups.name_of(key)}


@router.post("/groups/{group_key}/derive", dependencies=[Depends(require_admin)])
def derive_group(group_key: str):
    """The group's structure learned from its connected stores' products."""
    return _call(groups.derive, group_key)


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


class Access(BaseModel):
    client_id: str = ""
    client_secret: str = ""
    token: str = ""


@router.put("/stores/{store_key}/access", dependencies=[Depends(require_admin)])
def set_access(store_key: str, body: Access, x_actor: str | None = Header(default=None)):
    """Write-only: the values are stored encrypted and never returned."""
    return _call(stores.set_access, store_key, body.client_id, body.client_secret, body.token, actor_name(x_actor))


@router.delete("/stores/{store_key}/access", dependencies=[Depends(require_admin)])
def clear_access(store_key: str):
    _call(stores.clear_access, store_key)
    return {"ok": True}


@router.post("/stores/{store_key}/access/check")
def check_access(store_key: str):
    return _call(stores.check_access, store_key)
