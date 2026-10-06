"""Uploading a batch: only approved products, results kept per store, retry only the failed, no duplicates."""

import time
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlalchemy.orm import Session

from api.main import app
from db import review, upload
from db.models import Batch, Event
from db.repo import engine, save_batch
from pipeline.batch import run_batch
from pipeline.input import read_input
from pipeline.settings import ROOT
from pipeline.shopify import Shopify
from tests.fake_ai import FakeClient
from tests.fake_shopify import FakeShopify
from tests.test_batch import GROUP, STORES, responder

pytestmark = pytest.mark.db


@pytest.fixture
def batch(monkeypatch):
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    rows = read_input(ROOT / "input" / "sample-5.csv", GROUP, STORES)[:2]
    batch_id = save_batch(run_batch(FakeClient(responder=responder), rows, GROUP, STORES, "upload test"))
    data = review.get_batch(batch_id)
    first = data["products"][0]
    review.accept_all(first["id"], "Мария")
    review.approve(first["id"], "Мария")
    yield data
    with Session(engine()) as session, session.begin():
        session.execute(delete(Event).where(Event.batch_id == batch_id))
        session.execute(delete(Batch).where(Batch.id == batch_id))


@pytest.fixture
def shops():
    fakes = {s: FakeShopify() for s in STORES}
    return fakes, lambda group, store: Shopify(f"{store}.myshopify.com", "tok", http=fakes[store].client())


def items(batch_id: int, store: str) -> list[dict]:
    return next(s for s in upload.state(batch_id)["stores"] if s["key"] == store)["items"]


def test_only_approved_products_go_and_results_are_kept(batch, shops):
    fakes, client = shops
    counts = upload.run(batch["id"], "draft", client=client, actor="Мария")
    assert counts == {s: {"uploaded": 1, "failed": 0} for s in STORES}
    for store in STORES:
        first, second = items(batch["id"], store)
        assert first["upload_status"] == "uploaded" and first["upload_message"].startswith("създаден, чернова")
        assert first["shopify_url"] is None  # shop is CHANGE_ME in the seed: no admin link
        assert second["upload_status"] is None and second["blocker"] == "Продуктът не е одобрен."
        assert len(fakes[store].products) == 1
        sent = next(iter(fakes[store].products.values()))["input"]
        assert sent["files"][0]["originalSource"].startswith("https://staging.example/")
    assert fakes["parfemija"].uploads  # the composed PNG went through the staged upload

    upload.run(batch["id"], "active", client=client)
    for store in STORES:
        assert len(fakes[store].products) == 1  # updated, not duplicated
        assert items(batch["id"], store)[0]["upload_message"].startswith("обновен, активен")


def test_missing_credentials_fail_and_retry_sends_only_the_failed(batch, shops):
    fakes, client = shops
    counts = upload.run(batch["id"], "draft")  # real client: shop CHANGE_ME
    assert counts == {s: {"uploaded": 0, "failed": 1} for s in STORES}
    assert "stores.yaml" in items(batch["id"], "premierparfums")[0]["upload_message"]
    assert upload.state(batch["id"])["publish_status"] == "partial"
    assert upload.plan(batch["id"], only_failed=True) == [
        (i["store_product_id"], s) for s in STORES for i in items(batch["id"], s)[:1]
    ]
    upload.run(batch["id"], "draft", only_failed=True, client=client)
    assert all(items(batch["id"], s)[0]["upload_status"] == "uploaded" for s in STORES)
    assert upload.state(batch["id"])["publish_status"] == "uploaded"


def test_a_change_after_approval_keeps_the_product_out(batch, shops):
    _, client = shops
    product = batch["products"][0]
    price = product["stores"]["parfemija"]["fields"]["price"]
    review.decide(price["id"], "edit", "Мария", "60.00")  # withdraws the approval
    assert upload.run(batch["id"], "draft", client=client) == {}


def test_api_starts_in_the_background_and_reports(batch, shops, monkeypatch):
    _, client = shops
    monkeypatch.setattr("db.upload.store_client", client)
    api = TestClient(app)
    headers = {"X-Actor": quote("Мария")}
    response = api.post(f"/api/batches/{batch['id']}/upload", json={"status": "draft"}, headers=headers)
    assert response.status_code == 202
    for _ in range(100):
        state = api.get(f"/api/batches/{batch['id']}/upload").json()
        if not state["running"]:
            break
        time.sleep(0.1)
    assert state["done"] == state["total"] == 2 and not state["error"]
    assert {s["key"] for s in state["stores"]} == set(STORES)
    assert api.post(f"/api/batches/{batch['id']}/upload", json={"status": "live"}).status_code == 422
