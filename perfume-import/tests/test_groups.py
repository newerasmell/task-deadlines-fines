"""Group 3 and on made in the app: created, a store connected into it, its structure learned from that store's
products, then the store's template accepted, all without files in the repository."""

import threading

import pytest

from db import connect, groups, newbatch, stores
from pipeline.config import list_groups, load_group
from pipeline.shopify import Shopify
from tests.fake_shopify import FakeShopify
from tests.test_audit import batch  # noqa: F401  (the fixture)
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


def test_a_product_is_made_and_sent_in_a_learned_groups_stores(clean, monkeypatch, fixed_rates):  # noqa: F811
    """„Качи в магазините“ for a group 1 product into a learned group's stores: the product is made there by the
    group's rules and each store's template, then sent, in one job (decisions #50)."""
    from sqlalchemy import delete, select
    from sqlalchemy.orm import Session

    from db import publish, review
    from db.models import Batch, Event, Product, Store, StoreProduct, StoreProfile, StoreSecret
    from db.repo import engine
    from tests.fake_ai import FakeClient
    from tests.test_batch import HR, text
    from tests.test_batch import responder as base

    def responder(kw):  # the stores' own texts in any language, with the notes translated
        system = kw.get("system") or ""
        if not kw.get("tools") and (" into " in system or "for the online perfume shop" in system):
            return text(HR, notes=[{"en": t, "local": f"{t}-x"} for t in ["sicilian lemon", "rose", "vanilla"]])
        return base(kw)

    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    key = groups.create("Група Тест")
    first, pa = _connected("Test Connect Shop", "testconnect.myshopify.com", key)
    second, pb = _connected("Test Connect Two", "testconnect2.myshopify.com", key)
    sent = {}
    monkeypatch.setattr(publish, "_from_live", lambda pid, client=None, target=None: None)
    monkeypatch.setattr(publish, "plan", lambda pid: {"title": "Dior Sauvage EDT 100 ml", "ean": "3348901250146"})
    monkeypatch.setattr(publish, "_euro_price", lambda pid: ("69", "99"))
    monkeypatch.setattr(publish, "_codes", lambda pid: ("3348901250146", ""))
    monkeypatch.setattr(
        review,
        "publish",
        lambda pid, keys, status, actor: sent.update({k: pid for k in keys}) or {"stores": keys, "skipped": {}},
    )
    try:
        stores.accept(pb, key, "Мария")
        stores.accept(pa, key, "Мария")
        job = {"id": "parent", "running": True, "kind": "fill"}
        newbatch._jobs["parent"] = job  # the job that waits: another AI job may start beside it
        out = publish.make(1, [first, second], "active", "Мария", FakeClient(responder=responder), job)
        assert out == {first: "създаден, качва се в магазина…", second: "създаден, качва се в магазина…"}, out
        made = review.get_product(sent[first])
        assert set(made["stores"]) == {first, second}
        assert made["stores"][first]["fields"]["title"]["value"].endswith("100 ml")  # by the learned title rule
    finally:
        with Session(engine()) as session, session.begin():
            ids = set(
                session.execute(
                    select(Product.batch_id)
                    .join(StoreProduct, StoreProduct.product_id == Product.id)
                    .where(StoreProduct.store_key == second)
                ).scalars()
            )
            ids |= set(session.execute(select(Batch.id).where(Batch.store_key == second)).scalars())
            session.execute(delete(Event).where(Event.batch_id.in_(ids)))
            session.execute(delete(Batch).where(Batch.id.in_(ids)))
            for model in (StoreProfile, StoreSecret):
                session.execute(delete(model).where(model.store_key == second))
            session.execute(delete(Store).where(Store.key == second))


def _cleanup(stores_made: list[str]) -> None:
    from sqlalchemy import delete, select
    from sqlalchemy.orm import Session

    from db.models import Batch, Event, Product, Store, StoreProduct, StoreProfile, StoreSecret
    from db.repo import engine

    with Session(engine()) as session, session.begin():
        ids = set(
            session.execute(
                select(Product.batch_id)
                .join(StoreProduct, StoreProduct.product_id == Product.id)
                .where(StoreProduct.store_key.in_(stores_made))
            ).scalars()
        )
        ids |= set(session.execute(select(Batch.id).where(Batch.store_key.in_(stores_made))).scalars())
        session.execute(delete(Event).where(Event.batch_id.in_(ids)))
        session.execute(delete(Batch).where(Batch.id.in_(ids)))
        for model in (StoreProfile, StoreSecret):
            session.execute(delete(model).where(model.store_key.in_(stores_made)))
        session.execute(delete(Store).where(Store.key.in_(stores_made[1:])))  # the first one: the clean fixture


def test_a_group_1_product_keeps_its_ean_sku_and_picture_in_group_2(batch, clean, monkeypatch, fixed_rates):  # noqa: F811
    """Made from a live product: its own EAN and SKU (the team's code) are carried over, never made up, and a
    picture uploaded in the app is the one laid out for the new stores; a tester gets its sentence too."""
    from io import BytesIO

    from PIL import Image
    from sqlalchemy import select
    from sqlalchemy.orm import Session

    from db import publish, review
    from db.models import FieldRow, Media, Product, StoreProduct
    from db.repo import engine
    from pipeline import media
    from tests.fake_ai import FakeClient, message
    from tests.test_batch import HR, text
    from tests.test_batch import responder as base

    def responder(kw):
        system = kw.get("system") or ""
        if not kw.get("tools") and (" into " in system or "for the online perfume shop" in system):
            return text(HR, notes=[{"en": t, "local": f"{t}-x"} for t in ["sicilian lemon", "rose", "vanilla"]])
        content = str((kw.get("messages") or [{}])[0].get("content"))
        if "Listings:" in content:  # the live copies read together
            src = [{"url": content.split('"url": "')[1].split('"')[0], "says": "x", "supports": True}]
            facts = {"brand": "Paco Rabanne", "name": "Lady Million", "concentration": "Eau de Parfum"}
            facts.update(fragrance_family="Floral", ingredients="Alcohol", gender="Women's Perfume")
            data = {k: {"value": v, "sources": src} for k, v in facts.items()}
            data.update({k: {"value": ["rose"], "sources": src} for k in ("top_note", "middle_note", "base_note")})
            return message(data)
        return base(kw)

    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    monkeypatch.setattr(review, "publish", lambda pid, keys, status, actor: {"stores": keys, "skipped": {}})
    key = groups.create("Група Тест")
    first, pa = _connected("Test Connect Shop", "testconnect.myshopify.com", key)
    second, pb = _connected("Test Connect Two", "testconnect2.myshopify.com", key)
    try:
        stores.accept(pb, key, "Мария")
        stores.accept(pa, key, "Мария")
        product_id = review.get_batch(batch[0])["products"][0]["id"]
        blob = BytesIO()
        Image.new("RGB", (800, 1200), "white").save(blob, "PNG")
        stored = media.write(blob.getvalue())
        with Session(engine()) as session, session.begin():
            sku = session.execute(
                select(FieldRow)
                .join(StoreProduct, StoreProduct.id == FieldRow.store_product_id)
                .where(FieldRow.key == "sku", StoreProduct.product_id == product_id)
            ).scalar_one()
            sku.value = "PR-0777"  # the team's own code
            ean_row = session.execute(
                select(FieldRow)
                .join(StoreProduct, StoreProduct.id == FieldRow.store_product_id)
                .where(FieldRow.key == "ean", StoreProduct.product_id == product_id)
            ).scalar_one()
            real = ean_row.value
            ean_row.value = "5901234000005"  # a placeholder in this copy only: the store's real one travels
            session.add(
                Media(
                    product_id=product_id,
                    kind="original",
                    path=stored.path,
                    content_type="image/png",
                    width=800,
                    height=1200,
                    bytes=stored.bytes,
                    sha256=stored.sha256,
                    info={},
                )
            )
        job = {"id": "parent", "running": True, "kind": "fill"}
        newbatch._jobs["parent"] = job
        publish.make(product_id, [first, second], "active", "Мария", FakeClient(responder=responder), job)
        with Session(engine()) as session:
            new_id = session.execute(select(Product.id).order_by(Product.id.desc())).scalar()
        made = review.get_product(new_id)["stores"]
        for store in (first, second):
            assert made[store]["fields"]["sku"]["value"] == "PR-0777"
            assert made[store]["fields"]["ean"]["value"] == real
            assert made[store]["fields"]["image"]["value"]
        assert review.get_research(new_id)["research"]["images"][0]["url"].startswith("media:")
    finally:
        _cleanup([first, second])
