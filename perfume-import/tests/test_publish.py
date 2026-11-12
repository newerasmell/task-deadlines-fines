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


def test_sending_a_store_accepts_its_suggestions(batch, monkeypatch):  # noqa: F811
    """Picking a store in „Качи в магазините“ is the person's acceptance of its AI suggestions."""
    batch_id, rows = batch
    product = next(p for p in review.get_batch(batch_id)["products"] if p["id"] != _fixed(batch_id)["id"])
    vendor = product["stores"]["premierparfums"]["fields"]["vendor"]
    from sqlalchemy.orm import Session

    from db.models import FieldRow
    from db.repo import engine

    with Session(engine()) as session, session.begin():
        row = session.get(FieldRow, vendor["id"])
        row.previous, row.value, row.status, row.origin = row.value, "AI марка", "suggested", "ai_research"
    store = _store(product["id"])
    assert "Марка" in store["changes"] and store["accept"] == 1 and store["action"] == "update"

    handle = product["stores"]["premierparfums"]["fields"]["handle"]["value"]
    sku = product["stores"]["premierparfums"]["fields"]["sku"]["value"]
    fake = FakeShopify([{"id": "gid://shopify/Product/9", "handle": handle, "title": "x", "sku": sku}])
    monkeypatch.setattr(
        "db.live.store_client", lambda group, key: Shopify("p.myshopify.com", "tok", http=fake.client())
    )
    publish.run(product["id"], ["premierparfums"], "active", "Мария")
    after = review.get_product(product["id"])["stores"]["premierparfums"]["fields"]["vendor"]
    assert after["status"] == "ok" and after["decided_by"] == "Мария"
    assert fake.updates and fake.updates[0]["vendor"] == "AI марка"


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


def test_markup_and_number_format_are_not_a_change():
    """Shopify gives a description back with its own markup: the same words are not a change to send again."""
    from db.live import same

    ours = "<p>Tom Ford <strong>Fucking Fabulous</strong> είναι ένα   τολμηρό άρωμα.</p>"
    theirs = '<p class="x">Tom Ford <b>Fucking Fabulous</b> είναι ένα τολμηρό άρωμα.</p>\n'
    assert same(ours, theirs)
    assert same("124", "124.00") and same("124,5", "124.50")
    assert not same("<p>Нов текст.</p>", "<p>Стар текст.</p>") and not same("124", "125")
    assert same("Tom &amp; Ford", "Tom & Ford")


def test_a_new_sku_is_sent_to_the_product_known_by_its_shopify_id(batch, monkeypatch):  # noqa: F811
    """The SKU is the team's code: changed here (even twice), it is sent to the product the store read gave."""
    from sqlalchemy import update
    from sqlalchemy.orm import Session

    from db.models import StoreProduct
    from db.repo import engine

    batch_id, _ = batch
    product = _fixed(batch_id)
    fields = product["stores"]["premierparfums"]["fields"]
    live_sku, handle = fields["sku"]["value"], fields["handle"]["value"]
    with Session(engine()) as session, session.begin():
        session.execute(
            update(StoreProduct)
            .where(StoreProduct.product_id == product["id"])
            .values(shopify_product_id="gid://shopify/Product/9")
        )
    review.decide(fields["sku"]["id"], "edit", "Мария", "CH-0001")
    after = review.decide(fields["sku"]["id"], "edit", "Мария", "CH-0002")
    assert after["stores"]["premierparfums"]["fields"]["sku"]["previous"] == live_sku  # still the store's value

    fake = FakeShopify([{"id": "gid://shopify/Product/9", "handle": handle, "title": "x", "sku": live_sku}])
    monkeypatch.setattr(
        "db.live.store_client", lambda group, key: Shopify("p.myshopify.com", "tok", http=fake.client())
    )
    result = publish.run(product["id"], ["premierparfums"], "active", "Мария")
    assert "SKU" in result["done"]["premierparfums"], result
    assert fake.variant_updates and fake.variant_updates[0][0]["inventoryItem"]["sku"] == "CH-0002"
