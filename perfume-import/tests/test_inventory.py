"""„Включи наличностите“: the products the app created get inventory tracking on, the stores' own are left."""

import threading

import pytest
from sqlalchemy import delete, update
from sqlalchemy.orm import Session

from db import inventory, newbatch
from db.models import Batch, Event, StoreProduct
from db.repo import engine, save_batch
from pipeline.batch import run_batch
from pipeline.input import read_input
from pipeline.settings import ROOT
from pipeline.shopify import Shopify
from tests.fake_ai import FakeClient
from tests.fake_shopify import FakeShopify
from tests.test_batch import GROUP, STORES, responder

pytestmark = pytest.mark.db


def test_tracking_is_turned_on_for_the_products_made_here(monkeypatch):
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    monkeypatch.setattr(newbatch, "_jobs", {})
    rows = read_input(ROOT / "input" / "sample-5.csv", GROUP, STORES)[:2]
    batch_id = save_batch(run_batch(FakeClient(responder=responder), rows, GROUP, STORES, "inventory"))
    try:
        from db.models import Product

        with Session(engine()) as session, session.begin():
            ids = [
                sp.id
                for sp in session.query(StoreProduct)
                .join(Product, Product.id == StoreProduct.product_id)
                .where(Product.batch_id == batch_id, StoreProduct.store_key == "premierparfums")
            ]
            for n, sp_id in enumerate(ids):
                session.execute(
                    update(StoreProduct)
                    .where(StoreProduct.id == sp_id)
                    .values(shopify_product_id=f"gid://shopify/Product/9{n}")
                )
        fake = FakeShopify(
            [
                {"id": "gid://shopify/Product/90", "handle": "a", "title": "a", "sku": "a", "tracked": False},
                {"id": "gid://shopify/Product/91", "handle": "b", "title": "b", "sku": "b", "tracked": True},
            ]
        )
        shop = Shopify("p.myshopify.com", "tok", http=fake.client(), sleep=lambda s: None)
        assert inventory.made_here()["premierparfums"][:2] == ["gid://shopify/Product/90", "gid://shopify/Product/91"]
        job_id = inventory.start("Мария", shops={"premierparfums": shop})
        next(t for t in threading.enumerate() if t.name == f"inventory-{job_id}").join(timeout=60)
        job = newbatch.job(job_id)
        assert "premierparfums: 1 от 2" in job["result"]["message"], job
        assert fake.products["gid://shopify/Product/90"]["tracked"] is True
        assert len(fake.variant_updates) == 1  # the tracked one is left as it is
    finally:
        with Session(engine()) as session, session.begin():
            session.execute(delete(Event).where(Event.batch_id == batch_id))
            session.execute(delete(Batch).where(Batch.id == batch_id))
