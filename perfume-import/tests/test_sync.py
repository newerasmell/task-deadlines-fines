"""A store's products read live from Shopify: checked like an export, saved as the store's catalog, and what was
made here but is not in the store yet survives the next read."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from api.main import app
from db import catalog, review, sync
from db.models import Batch, Event, StoreProduct
from db.repo import engine
from pipeline.export import load_export
from pipeline.shopify import Shopify, _metafield_text
from tests.conftest import FIXTURES
from tests.fake_shopify import FakeShopify

pytestmark = pytest.mark.db
STORE = "premierparfums"


def _products(n: int) -> list[dict]:
    export = load_export(FIXTURES / "premierparfums_export.csv")
    rows = [r for r in export.products if r["Variant SKU"].startswith("SK")][:n]
    out = []
    for i, r in enumerate(rows):
        metafields = [
            {"namespace": m.namespace, "key": m.key, "value": r[m.column], "type": "single_line_text_field"}
            for m in export.metafields
            if m.namespace == "custom" and r[m.column]
        ]
        out.append(
            {
                "id": f"gid://shopify/Product/{i + 1}",
                "handle": r["Handle"],
                "title": r["Title"],
                "sku": r["Variant SKU"],
                "body": r["Body (HTML)"],
                "vendor": r["Vendor"],
                "price": r["Variant Price"],
                "image": r["Image Src"],
                "metafields": metafields,
            }
        )
    return out


@pytest.fixture
def shop(monkeypatch):
    monkeypatch.setattr(sync, "_group_of", lambda key: "group-1")
    fake = FakeShopify(_products(30))
    yield Shopify("gr.myshopify.com", "tok", http=fake.client(), sleep=lambda s: None)
    with Session(engine()) as session, session.begin():
        ids = list(session.execute(select(Batch.id).where(Batch.store_key == STORE)).scalars())
        session.execute(delete(Event).where(Event.batch_id.in_(ids)))
        session.execute(delete(Batch).where(Batch.id.in_(ids)))


def test_the_whole_catalog_is_read_page_by_page(shop):
    result = sync.run(STORE, "Мария", shop)
    assert result["products"] == 30
    batch = review.get_batch(result["batch_id"])
    assert batch["kind"] == "audit" and len(batch["products"]) == 30
    fields = batch["products"][0]["stores"][STORE]["fields"]
    assert fields["top_note"]["value"] and fields["sku"]["value"].startswith("SK")
    with Session(engine()) as session:
        gids = session.execute(
            select(StoreProduct.shopify_product_id).where(
                StoreProduct.product_id.in_([p["id"] for p in batch["products"]])
            )
        ).scalars()
        assert all(g and g.startswith("gid://shopify/Product/") for g in gids)
    ean = batch["products"][0]["ean"]
    entry = next(e for e in catalog.catalog(q=ean)["items"] if e["ean"] == ean)
    assert entry["stores"][STORE]["batch_id"] == result["batch_id"]


def test_an_edit_not_yet_in_the_store_survives_the_next_read(shop):
    first = sync.run(STORE, "Мария", shop)
    product = review.get_batch(first["batch_id"])["products"][0]
    vendor = product["stores"][STORE]["fields"]["vendor"]
    review.decide(vendor["id"], "edit", "Мария", "Нова марка")

    second = sync.run(STORE, "Мария", shop)
    assert second["carried"] == 1
    assert second["batch_id"] == first["batch_id"]  # the same catalog, updated in place
    again = review.get_product(product["id"])["stores"][STORE]  # the same product, the same address
    field = again["fields"]["vendor"]
    assert field["value"] == "Нова марка" and field["previous"] == vendor["value"] and field["decided_by"] == "Мария"
    entry = next(e for e in catalog.catalog(q=product["ean"])["items"] if e["ean"] == product["ean"])
    assert entry["stores"][STORE]["state"] == "diff"


def test_metafields_read_as_an_export_writes_them():
    assert _metafield_text('["jasmine","rose"]', "list.single_line_text_field") == "jasmine, rose"
    assert _metafield_text('{"value":100.0,"unit":"MILLILITERS"}', "volume") == "100 ml"
    assert _metafield_text("Floral", "single_line_text_field") == "Floral"
    assert _metafield_text(None, "volume") == ""


def test_nothing_to_read_is_refused():
    client = TestClient(app)
    response = client.post("/api/stores/sync", json={"stores": []})
    assert response.status_code == 409 and "Няма свързан магазин" in response.json()["detail"]


def test_a_store_read_and_an_ai_job_run_side_by_side(monkeypatch):
    from db import newbatch

    monkeypatch.setattr(newbatch, "_jobs", {"s": {"running": True, "kind": "sync"}})
    newbatch.busy()  # an AI job may start while the stores are read
    with pytest.raises(newbatch.NewBatchError, match="изтеглят"):
        newbatch.busy(sync=True)
    monkeypatch.setattr(newbatch, "_jobs", {"f": {"running": True, "kind": "fill", "stage_label": "Чета страницата"}})
    newbatch.busy(sync=True)  # and the other way round
    with pytest.raises(newbatch.NewBatchError, match="Чета страницата"):
        newbatch.busy()


def test_checking_one_product_in_the_store_shows_what_did_not_reach_it(monkeypatch):
    """The app thought an edit was live (previous == value) but the store still has the old value: „Провери в
    магазина“ reads the product again and the edit waits to go live once more; what the store changed is taken."""
    from sqlalchemy.orm import Session as S

    from db import live
    from db.models import FieldRow

    monkeypatch.setattr(sync, "_group_of", lambda key: "group-1")
    products = _products(3)
    fake = FakeShopify(products)
    shop = Shopify("gr.myshopify.com", "tok", http=fake.client(), sleep=lambda s: None)
    result = sync.run(STORE, "Мария", shop)
    try:
        product = review.get_batch(result["batch_id"])["products"][0]
        vendor = product["stores"][STORE]["fields"]["vendor"]
        review.decide(vendor["id"], "edit", "Мария", "Нова марка")
        with S(engine()) as session, session.begin():  # as if it had been sent
            session.get(FieldRow, vendor["id"]).previous = "Нова марка"
        assert not [c for c in live.changes(product["id"])["changes"] if c["key"] == "vendor"]
        fake.products[products[0]["id"]]["body"] = "<p>Нов текст в магазина.</p>"

        after = sync.refresh_product(product["id"], "Мария", shop)
        change = next(c for c in after["changes"] if c["key"] == "vendor")
        assert change["after"] == "Нова марка" and change["before"] == products[0]["vendor"]
        body = review.get_product(product["id"])["stores"][STORE]["fields"]["body_html"]
        assert body["value"] == "<p>Нов текст в магазина.</p>"
    finally:
        with Session(engine()) as session, session.begin():
            ids = list(session.execute(select(Batch.id).where(Batch.store_key == STORE)).scalars())
            session.execute(delete(Event).where(Event.batch_id.in_(ids)))
            session.execute(delete(Batch).where(Batch.id.in_(ids)))


def test_a_read_keeps_ids_adds_new_products_and_removes_gone_ones(shop):
    first = sync.run(STORE, "Мария", shop)
    ids = {p["id"] for p in review.get_batch(first["batch_id"])["products"]}
    fake = shop.http._transport.handler.__self__  # the FakeShopify behind the client
    gone = next(iter(fake.products))
    del fake.products[gone]
    fake.products["gid://shopify/Product/999"] = {
        "id": "gid://shopify/Product/999",
        "handle": "brand-new-15-ml",
        "title": "Brand New EDP 15 ml",
        "sku": "SKNEW",
    }
    second = sync.run(STORE, "Мария", shop)
    after = {p["id"] for p in review.get_batch(second["batch_id"])["products"]}
    assert second["batch_id"] == first["batch_id"]
    assert len(ids - after) == 1 and len(after - ids) == 1 and len(ids & after) == len(ids) - 1
