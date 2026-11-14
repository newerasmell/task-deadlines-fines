"""Group 3 and on made in the app: created, a store connected into it, its structure learned from that store's
products, then the store's template accepted, all without files in the repository."""

import threading

import pytest

from db import connect, groups, newbatch, stores
from pipeline.config import list_groups, load_group
from pipeline.shopify import Shopify
from tests.fake_shopify import FakeShopify
from tests.test_connect import clean  # noqa: F401  (the fixture: removes the test store)
from tests.test_sync import _products

pytestmark = pytest.mark.db


def test_a_new_group_gets_its_structure_from_its_connected_store(clean):  # noqa: F811
    key = groups.create("Група Тест")
    assert key in list_groups() and load_group(key).spec is None and groups.name_of(key) == "Група Тест"

    store, group = connect.prepare(
        None, "Test Connect Shop", key, "testconnect.myshopify.com", "EE", "et", "EUR", "id", "secret", "", "Мария"
    )
    assert group == key and store in load_group(key).stores
    shop = Shopify("testconnect.myshopify.com", "tok", http=FakeShopify(_products(12)).client(), sleep=lambda s: None)
    job_id = connect.start(store, group, "Мария", shop)
    next(t for t in threading.enumerate() if t.name == f"connect-{job_id}").join(timeout=120)
    profile_id = newbatch.job(job_id)["result"]["profile_id"]

    summary = groups.derive(key)
    assert summary["stores"] == [store] and summary["products"] == 12
    learned = load_group(key)
    assert learned.spec is not None and (learned.path / "image" / "layout.yaml").exists()
    assert stores.accept(profile_id, key, "Мария")["audit_batch_id"]


def _connected(name: str, shop: str, group: str) -> tuple[str, int]:
    store, _ = connect.prepare(None, name, group, shop, "EE", "et", "EUR", "id", "secret", "", "Мария")
    fake = Shopify(shop, "tok", http=FakeShopify(_products(12)).client(), sleep=lambda s: None)
    job_id = connect.start(store, group, "Мария", fake)
    next(t for t in threading.enumerate() if t.name == f"connect-{job_id}").join(timeout=120)
    return store, newbatch.job(job_id)["result"]["profile_id"]


def test_a_group_learns_its_structure_once_two_stores_are_connected(clean):  # noqa: F811
    """Group 2, 3…: one connected store is too little; with the second, „Запази шаблона“ learns the group's
    structure from both and accepts, no extra step."""
    from sqlalchemy import delete, select
    from sqlalchemy.orm import Session

    from db.models import Batch, Event, Store, StoreProfile, StoreSecret
    from db.repo import engine

    key = groups.create("Група Тест")
    _, first = _connected("Test Connect Shop", "testconnect.myshopify.com", key)
    with pytest.raises(stores.StoreError, match="Свържи още 1 магазин"):
        stores.accept(first, key, "Мария")
    assert load_group(key).spec is None
    second_key, second = _connected("Test Connect Two", "testconnect2.myshopify.com", key)
    try:
        assert stores.accept(second, key, "Мария")["audit_batch_id"]
        assert load_group(key).spec is not None
        assert stores.accept(first, key, "Мария")["audit_batch_id"]
    finally:
        with Session(engine()) as session, session.begin():
            ids = list(session.execute(select(Batch.id).where(Batch.store_key == second_key)).scalars())
            session.execute(delete(Event).where(Event.batch_id.in_(ids)))
            session.execute(delete(Batch).where(Batch.id.in_(ids)))
            for model in (StoreProfile, StoreSecret):
                session.execute(delete(model).where(model.store_key == second_key))
            session.execute(delete(Store).where(Store.key == second_key))


def test_a_group_needs_a_connected_store_to_learn_from():
    key = groups.create("")
    with pytest.raises(groups.GroupError, match="свържи поне един магазин"):
        groups.derive(key)
