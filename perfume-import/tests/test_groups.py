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

    with pytest.raises(stores.StoreError, match="group.yaml"):
        stores.accept(profile_id, key, "Мария")  # no structure yet
    summary = groups.derive(key)
    assert summary["stores"] == [store] and summary["products"] == 12
    learned = load_group(key)
    assert learned.spec is not None and (learned.path / "image" / "layout.yaml").exists()
    assert stores.accept(profile_id, key, "Мария")["audit_batch_id"]


def test_a_group_needs_a_connected_store_to_learn_from():
    key = groups.create("")
    with pytest.raises(groups.GroupError, match="свържи поне един магазин"):
        groups.derive(key)
