"""„Качи в магазините“: per store what goes (the changed fields of a live product), what waits on a person (an
AI suggestion not yet accepted), and the push itself."""

import pytest

from db import publish, review
from pipeline.shopify import Shopify
from tests.fake_ai import FakeClient, message
from tests.fake_shopify import FakeShopify
from tests.test_audit import batch  # noqa: F401  (the fixture)
from tests.test_catalog import audits  # noqa: F401  (the fixture)

pytestmark = pytest.mark.db


def _fixed(batch_id: int) -> dict:
    return next(
        p
        for p in review.get_batch(batch_id)["products"]
        if p["stores"]["premierparfums"]["fields"]["gender"]["status"] == "fixed"
    )


def _wait(job_id: str) -> dict:
    import threading

    from db import newbatch

    next(t for t in threading.enumerate() if t.name == f"align-{job_id}").join(timeout=120)
    return newbatch.job(job_id)


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

    def quick(items, keys, actor, client=None, research=None, besides=None):
        asked.update(items=items, keys=keys, research=research)
        newbatch._jobs["j1"] = {"id": "j1", "running": False, "error": "стоп в теста", "batch_id": None}
        return "j1"

    monkeypatch.setattr(newbatch, "quick_start", quick)
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
    job = _wait(result["job_id"])
    assert asked["keys"] == ["parfemija"] and "стоп в теста" in job["result"]["parfemija"]
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


def test_align_entry(audits, monkeypatch):  # noqa: F811
    """„Качи в магазините“ + изравни: the open GR copy's family and notes (translated) and a new description
    reach the HR copy of the same product, as decided changes waiting to go live there."""
    from db import catalog, fill
    from tests.test_catalog import _hr_rows, _set

    words = {"el": {"amber": "κεχριμπάρι"}, "hr": {"amber": "jantar", "musk": "mošus"}}
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: words.get(lang, {}))
    monkeypatch.setattr("pipeline.fill.load_glossary", lambda lang: words.get(lang, {}))
    (gr, hr), (shared, _) = audits
    gr_product = next(p for p in review.get_batch(gr)["products"] if p["ean"] == shared)
    g = gr_product["stores"]["premierparfums"]["fields"]
    _set(g["fragrance_family"]["id"], value="Woody", status="ok")
    _set(g["base_note"]["id"], value="κεχριμπάρι, μόσχος", value_en="amber, musk", status="ok")
    _set(g["sku"]["id"], value="CH-NEW-15", status="ok")  # a new SKU set in GR goes to HR too
    before = _hr_rows(hr, shared)

    def answers(kwargs):
        system = str(kwargs.get("system", ""))
        if "Translate perfume note names" in system:
            return message({"notes": [{"en": "musk", "local": "mošus"}]})
        if "Extract the perfume notes" in system:  # the GR notes kept only in Greek
            return message({"notes": ["bergamot"]})
        from tests.test_batch import responder

        return responder(kwargs)

    done, _ = fill.spread_entry(gr_product["id"], ["parfemija"], "Мария", FakeClient(responder=answers))
    assert done["parfemija"].startswith("изравнен")
    after = _hr_rows(hr, shared)
    assert after["fragrance_family"]["value"] == "Woody" and after["fragrance_family"]["decided_by"] == "Мария"
    assert (
        after["base_note"]["value"] == "jantar, mošus"
        and after["base_note"]["previous"] == before["base_note"]["value"]
    )
    assert after["body_html"]["origin"] == "ai_generated"
    assert after["sku"]["value"] == "CH-NEW-15" and after["sku"]["previous"] == before["sku"]["value"]
    entry = next(e for e in catalog.catalog(q=shared)["items"] if e["ean"] == shared)
    assert entry["stores"]["parfemija"]["state"] == "diff"  # waiting to go live in HR


def test_a_product_is_made_in_another_groups_stores_by_their_rules(batch, monkeypatch, fixed_rates):  # noqa: F811
    """Group 2, 3…: a store of another group with a structure is offered too; one quick product per group, one
    after the other, each with the facts in its own group's vocabulary (decisions #50)."""
    import pipeline.config
    from db import newbatch, stores

    batch_id, _ = batch
    product = _fixed(batch_id)
    real, real_group = stores.list_stores(), pipeline.config.load_group
    extra = {**real[0], "key": "bgstore", "label": "BG", "group": "group-9", "profile_accepted": True}
    monkeypatch.setattr(stores, "list_stores", lambda: [*real, extra])
    monkeypatch.setattr(pipeline.config, "load_group", lambda k: real_group("group-1" if k == "group-9" else k))
    missing = {s["store"]: s for s in publish.plan(product["id"])["stores"] if s["action"] == "missing"}
    assert missing["bgstore"]["group"] == "group-9"

    vocab, calls = [], []
    monkeypatch.setattr(publish, "_from_live", lambda pid, client=None, target=None: vocab.append(target) or {})

    def quick(items, keys, actor, client=None, research=None, besides=None):
        calls.append(keys)
        job_id = f"j{len(calls)}"
        newbatch._jobs[job_id] = {"id": job_id, "running": False, "error": "стоп в теста", "batch_id": None}
        return job_id

    monkeypatch.setattr(newbatch, "quick_start", quick)
    others = [k for k in missing if k != "bgstore"]
    result = publish.run(product["id"], [*others, "bgstore"], "active", "Мария", client=FakeClient())
    job = _wait(result["job_id"])
    assert calls[-1] == ["bgstore"] and vocab[-1] == "group-9"
    assert set(job["result"]) == {*others, "bgstore"}
    assert sorted(k for c in calls for k in c) == sorted([*others, "bgstore"])
