"""Deleting a product prepared here: only a new one that is in no store yet; the import goes with its last."""

import pytest
from sqlalchemy import delete, update
from sqlalchemy.orm import Session

from db import review
from db.models import Batch, Event, StoreProduct
from db.repo import engine, save_batch
from pipeline.batch import run_batch
from pipeline.input import read_input
from pipeline.settings import ROOT
from tests.fake_ai import FakeClient
from tests.test_audit import batch  # noqa: F401  (a store's catalog)
from tests.test_batch import GROUP, STORES, responder

pytestmark = pytest.mark.db


@pytest.fixture
def prepared(monkeypatch):
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    rows = read_input(ROOT / "input" / "sample-5.csv", GROUP, STORES)[:2]
    batch_id = save_batch(run_batch(FakeClient(responder=responder), rows, GROUP, STORES, "delete test"))
    yield batch_id
    with Session(engine()) as session, session.begin():
        session.execute(delete(Event).where(Event.batch_id == batch_id))
        session.execute(delete(Batch).where(Batch.id == batch_id))


def test_a_prepared_product_is_deleted_and_the_empty_import_with_it(prepared):
    first, second = (p["id"] for p in review.get_batch(prepared)["products"])
    assert review.delete_product(first, "Мария") == {"deleted": first, "batch_deleted": False}
    assert [p["id"] for p in review.get_batch(prepared)["products"]] == [second]
    assert review.delete_product(second, "Мария")["batch_deleted"] is True
    with pytest.raises(KeyError):
        review.get_batch(prepared)


def test_a_product_already_in_a_store_is_not_deleted(prepared):
    product_id = review.get_batch(prepared)["products"][0]["id"]
    with Session(engine()) as session, session.begin():
        session.execute(
            update(StoreProduct).where(StoreProduct.product_id == product_id).values(upload_status="uploaded")
        )
    with pytest.raises(review.ReviewError, match="изтрий го първо в Shopify"):
        review.delete_product(product_id, "Мария")


def test_a_store_catalog_product_is_not_deleted(batch):  # noqa: F811
    batch_id, _ = batch
    product_id = review.get_batch(batch_id)["products"][0]["id"]
    with pytest.raises(review.ReviewError, match="каталога на магазина"):
        review.delete_product(product_id, "Мария")
