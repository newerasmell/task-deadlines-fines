"""„Качи в магазините“: per store what goes (the changed fields of a live product), what waits on a person (an
AI suggestion not yet accepted), and the push itself."""

import pytest

from db import publish, review
from pipeline.shopify import Shopify
from tests.fake_ai import FakeClient, message
from tests.fake_shopify import FakeShopify
from tests.test_audit import batch  # noqa: F401  (the fixture)

pytestmark = pytest.mark.db


def _fixed(batch_id: int) -> dict:
    return next(
        p
        for p in review.get_batch(batch_id)["products"]
        if p["stores"]["premierparfums"]["fields"]["gender"]["status"] == "fixed"
    )


def _store(product_id: int) -> dict:
    return next(s for s in publish.plan(product_id)["stores"] if s["product_id"] == product_id)


def test_a_live_product_sends_only_its_changed_fields(batch, monkeypatch):  # noqa: F811
    batch_id, rows = batch
    product = _fixed(batch_id)
    store = _store(product["id"])
    assert store["action"] == "update" and store["changes"] == ["Пол"]

    row = rows[0]
    fake = FakeShopify(
        [{"id": "gid://shopify/Product/7", "handle": row["Handle"], "title": row["Title"], "sku": row["Variant SKU"]}]
    )
    monkeypatch.setattr(
        "db.live.store_client", lambda group, key: Shopify("p.myshopify.com", "tok", http=fake.client())
    )
    result = publish.run(product["id"], ["premierparfums"], "active", "Мария")
    assert "Обновени в магазина: Пол" in result["done"]["premierparfums"]
    assert fake.updates and _store(product["id"])["action"] == "none"


def test_an_ai_suggestion_waits_until_it_is_accepted(batch):  # noqa: F811
    batch_id, _ = batch
    product = next(p for p in review.get_batch(batch_id)["products"] if p["id"] != _fixed(batch_id)["id"])
    vendor = product["stores"]["premierparfums"]["fields"]["vendor"]
    from sqlalchemy.orm import Session

    from db.models import FieldRow
    from db.repo import engine

    with Session(engine()) as session, session.begin():
        row = session.get(FieldRow, vendor["id"])
        row.previous, row.value, row.status, row.origin = row.value, "AI марка", "suggested", "ai_research"
    store = _store(product["id"])
    assert "Марка" not in store["changes"] and "1 предложение за приемане" in (store["reason"] or "")
    review.decide(vendor["id"], "accept", "Мария")
    store = _store(product["id"])
    assert "Марка" in store["changes"] and store["action"] == "update"


def test_a_store_without_the_product_can_have_it_made(batch, monkeypatch, fixed_rates):  # noqa: F811
    from db import newbatch, stores

    batch_id, _ = batch
    product = _fixed(batch_id)
    real = stores.list_stores()
    monkeypatch.setattr(
        stores,
        "list_stores",
        lambda: [{**s, "profile_accepted": s["key"] in ("premierparfums", "parfemija")} for s in real],
    )
    missing = [s for s in publish.plan(product["id"])["stores"] if s["action"] == "missing"]
    if not any(s["store"] == "parfemija" for s in missing):
        pytest.skip("parfemija already has this EAN in this database")
    asked = {}
    monkeypatch.setattr(
        newbatch,
        "quick_start",
        lambda items, keys, actor, client=None, research=None: (
            asked.update(items=items, keys=keys, research=research) or "j1"
        ),
    )
    seen = {}

    def unify(kwargs):  # the live copy read into English facts, the store page as the source
        listing = kwargs["messages"][0]["content"]
        seen["listing"] = listing
        url = listing.split('"url": "')[1].split('"')[0]
        src = [{"url": url, "says": "Women", "supports": True}]
        empty = {"value": "", "sources": []}
        data = {k: empty for k in ("brand", "name", "concentration", "fragrance_family", "ingredients")}
        data.update(
            gender={"value": "Women's Perfume", "sources": src},
            top_note={"value": [], "sources": []},
            middle_note={"value": [], "sources": []},
            base_note={"value": [], "sources": []},
        )
        return message(data)

    result = publish.run(product["id"], ["parfemija"], "active", "Мария", client=FakeClient(responder=unify))
    assert result["job_id"] == "j1" and asked["keys"] == ["parfemija"]
    item = asked["items"][0]
    assert item["ean"] == product["ean"] and float(item["price"]) > 0
    research = asked["research"]  # facts from the live store, no web research
    assert research["gender"]["value"] == "Women's Perfume" and research["_from_stores"]
    assert "premierparfums" in seen["listing"] or ".shop/products/" in seen["listing"]
