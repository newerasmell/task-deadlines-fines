"""„Свържи магазин“: a new store from its address and access only; its template learned from its products read
from Shopify, then accepted, which saves them as its catalog (with their Shopify ids)."""

import threading

import pytest
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from db import connect, newbatch, stores
from db.models import Batch, Event, Store, StoreProduct, StoreProfile, StoreSecret
from db.repo import engine
from pipeline.shopify import Shopify
from tests.fake_shopify import FakeShopify
from tests.test_sync import _products

pytestmark = pytest.mark.db
KEY = "testconnectshop"


@pytest.fixture
def clean(monkeypatch):
    monkeypatch.setattr(stores, "check_access", lambda key: {"ok": True, "message": "Връзката работи."})
    monkeypatch.setattr(newbatch, "_jobs", {})
    yield
    with Session(engine()) as session, session.begin():
        ids = list(session.execute(select(Batch.id).where(Batch.store_key == KEY)).scalars())
        session.execute(delete(Event).where(Event.batch_id.in_(ids)))
        session.execute(delete(Batch).where(Batch.id.in_(ids)))
        session.execute(delete(StoreProfile).where(StoreProfile.store_key == KEY))
        session.execute(delete(StoreSecret).where(StoreSecret.store_key == KEY))
        session.execute(delete(Store).where(Store.key == KEY))


def test_a_new_store_is_connected_and_its_template_learned_from_shopify(clean):
    with pytest.raises(stores.StoreError, match="държава"):
        connect.prepare(None, "Test Connect Shop", "group-1", "", "", "el", "EUR", "", "", "", "Мария")
    key, group = connect.prepare(
        None,
        "Test Connect Shop",
        "group-1",
        "testconnect.myshopify.com",
        "GR",
        "el",
        "EUR",
        "id",
        "secret",
        "",
        "Мария",
    )
    assert (key, group) == (KEY, "group-1")
    shop = Shopify("testconnect.myshopify.com", "tok", http=FakeShopify(_products(12)).client(), sleep=lambda s: None)
    job_id = connect.start(key, group, "Мария", shop)
    next(t for t in threading.enumerate() if t.name == f"connect-{job_id}").join(timeout=120)
    job = newbatch.job(job_id)
    assert job["error"] is None, job
    profile_id = job["result"]["profile_id"]
    accepted = stores.accept(profile_id, "group-1", "Мария")
    with Session(engine()) as session:
        gids = (
            session.execute(
                select(StoreProduct.shopify_product_id)
                .join(Batch, Batch.store_key == StoreProduct.store_key)
                .where(Batch.id == accepted["audit_batch_id"], StoreProduct.store_key == KEY)
            )
            .scalars()
            .all()
        )
    assert gids and all(g and g.startswith("gid://shopify/Product/") for g in gids)
    row = next(s for s in stores.list_stores() if s["key"] == KEY)
    assert row["state"] == "active" and row["checked_at"]
