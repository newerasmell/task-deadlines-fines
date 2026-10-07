"""A whole batch with the fake client: research once, texts per language, fields per store, validation, DB."""

from dataclasses import replace

import pytest
from sqlalchemy import delete
from sqlalchemy.orm import Session

from pipeline.batch import facts_for_text, run_batch
from pipeline.config import load_group
from pipeline.fields import Field
from pipeline.input import read_input
from pipeline.research import Research
from pipeline.settings import ROOT
from tests.fake_ai import FakeClient, message
from tests.test_generate import EL, EN, HR, SEO, text
from tests.test_research import A, B, C, research_answer

GROUP = load_group("group-1")
STORES = ["premierparfums", "parfemija"]


def responder(kwargs):
    if kwargs.get("tools"):  # research
        return message(research_answer(), urls=[A, B, C], searches=4)
    system = kwargs["system"]
    if "into Greek" in system:
        return text(EL, notes=[{"en": t, "local": f"{t}-el"} for t in ["sicilian lemon", "rose", "vanilla"]])
    if '"PremierParfums' in system and "in Greek" in system:  # the store's own text (pipeline.generate.STORE_SYSTEM)
        own = f"<p>{EL[:150]}</p><p>{EL[150:]}</p>"
        return text(own, notes=[{"en": t, "local": f"{t}-el"} for t in ["sicilian lemon", "rose", "vanilla"]])
    if "into Croatian" in system:
        return text(HR, notes=[{"en": t, "local": f"{t}-hr"} for t in ["sicilian lemon", "rose", "vanilla"]])
    return message({"description": EN, "seo_description": SEO})


@pytest.fixture
def rows():
    return read_input(ROOT / "input" / "sample-5.csv", GROUP, STORES)[:2]


def test_batch_builds_and_validates_every_store(rows, monkeypatch):
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    client = FakeClient(responder=responder)
    result = run_batch(client, rows, GROUP, STORES, "test")
    research_calls = [c for c in client.calls if c.get("tools")]
    assert len(research_calls) == 2  # once per product, shared by both stores
    assert len(client.calls) == 2 * 4  # research + master + el + hr per product

    p = result.products[0]
    gr, hr = p.stores["premierparfums"], p.stores["parfemija"]
    assert gr["title"].value == f"Paco Rabanne Lady Million Empire EDP {rows[0].ml:g} ml TESTER"
    assert gr["title"].status == "ok"
    assert gr["sku"].value == f"SK{rows[0].ean}" and gr["ean"].status == "ok"
    assert gr["gender"].value == hr["gender"].value == "Women's Perfume"
    assert gr["google.gender"].value == "Women"
    assert gr["body_html"].value.startswith("<p>Το Paco") and hr["body_html"].value.startswith("<p>Paco")
    assert gr["body_html"].value_en.startswith("<p>" + EN)
    assert rows[0].tester and GROUP.spec.tester_sentence["el"] in gr["body_html"].value
    assert gr["top_note"].value == "sicilian lemon-el" and gr["top_note"].value_en == "sicilian lemon"
    assert gr["price"].value == rows[0].prices["premierparfums"]
    assert gr["image"].status == "suggested" and "1200×1200" in gr["image"].message  # downloaded and measured
    assert "Сглобена върху фона на магазина: 1080×1080 px" in gr["image"].message
    assert p.composed["premierparfums"] is p.composed["parfemija"]  # same layout -> one picture
    assert "custom.sklad" not in gr
    blocked = {k: f.message for k, f in gr.items() if f.status == "blocked"}
    assert blocked == {}, blocked
    s = result.summary()
    assert s["products"] == 2 and set(s["stores"]) == set(STORES)
    assert s["cost_usd"] > 0


def test_failed_research_blocks_title_but_keeps_input(rows):
    client = FakeClient(responder=lambda kw: message(stop_reason="refusal", text="", category="bio"))
    result = run_batch(client, rows[:1], GROUP, STORES, "test")
    gr = result.products[0].stores["premierparfums"]
    assert gr["title"].status == "blocked"
    assert gr["body_html"].status == "blocked"
    assert gr["price"].value == rows[0].prices["premierparfums"]


def test_saved_research_is_reused(rows, monkeypatch):
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    first = run_batch(FakeClient(responder=responder), rows[:1], GROUP, STORES, "test")
    raw = first.products[0].research.raw
    client = FakeClient(responder=responder)
    second = run_batch(client, rows[:1], GROUP, STORES, "test", saved_research=lambda ean: raw)
    assert not [c for c in client.calls if c.get("tools")]
    assert second.products[0].reused_research and "research" not in second.products[0].usage


@pytest.mark.db
def test_batch_is_saved(rows, monkeypatch):
    from fastapi.testclient import TestClient
    from sqlalchemy import select

    from api.main import app
    from db.models import Batch, Event, FieldRow, Media, Product, StoreProduct
    from db.repo import batch_counts, batch_pictures, engine, find_research, replace_composed, save_batch
    from pipeline import media
    from pipeline.compose import compose_for_stores

    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    result = run_batch(FakeClient(responder=responder), rows, GROUP, STORES, "test")
    batch_id = save_batch(result)
    try:
        expected = {}
        for p in result.products:
            for fields in p.stores.values():
                for f in fields.values():
                    expected[f.status] = expected.get(f.status, 0) + 1
        assert batch_counts(batch_id) == expected
        assert find_research(rows[0].ean)["brand"]["value"] == "Paco Rabanne"

        # Pictures: one original + one composition per layout per product, the field points at the composition.
        with Session(engine()) as session:
            pictures = (
                session.execute(select(Media).join(Product).where(Product.batch_id == batch_id).order_by(Media.id))
                .scalars()
                .all()
            )
            assert [m.kind for m in pictures] == ["original", "composed"] * len(rows)
            composed = pictures[1]
            assert (composed.width, composed.height) == (1080, 1080) and composed.layout == "group"
            assert media.resolve(composed.path).read_bytes()[:4] == b"\x89PNG"
            image = (
                session.execute(
                    select(FieldRow)
                    .join(StoreProduct)
                    .where(StoreProduct.product_id == composed.product_id, FieldRow.key == "image")
                )
                .scalars()
                .all()
            )
            assert {f.value for f in image} == {f"/api/media/{composed.id}"}  # both stores share the layout
            assert image[0].alternatives == [f"/api/media/{pictures[0].id}"]
            assert image[0].sources[0]["url"].startswith("http")

        response = TestClient(app).get(f"/api/media/{composed.id}")
        assert response.status_code == 200 and response.headers["content-type"] == "image/png"
        assert TestClient(app).get("/api/media/999999999").status_code == 404

        # Recompose after a layout change: new picture, old value kept in `previous`.
        first = batch_pictures(batch_id)[0]
        assert first["original"].id == pictures[0].id and first["stores"] == STORES
        data = media.resolve(first["original"].path).read_bytes()
        smaller = {s: replace(c, layout="smaller") for s, c in compose_for_stores(data, GROUP, STORES).items()}
        replace_composed(first["product_id"], first["original"], smaller, 1000, "test")
        with Session(engine()) as session:
            image = (
                session.execute(
                    select(FieldRow)
                    .join(StoreProduct)
                    .where(StoreProduct.product_id == first["product_id"], FieldRow.key == "image")
                )
                .scalars()
                .all()
            )
            newest = session.execute(
                select(Media).where(Media.product_id == first["product_id"]).order_by(Media.id.desc()).limit(1)
            ).scalar_one()
            assert newest.layout == "smaller"
            assert {f.value for f in image} == {f"/api/media/{newest.id}"}
            assert {f.previous for f in image} == {f"/api/media/{composed.id}"}
    finally:
        with Session(engine()) as session, session.begin():
            session.execute(delete(Event).where(Event.batch_id == batch_id))
            session.execute(delete(Batch).where(Batch.id == batch_id))


def test_texts_go_through_two_message_batches(rows, monkeypatch):
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    monkeypatch.setattr("pipeline.ai.time.sleep", lambda s: None)
    client = FakeClient(responder=responder)
    result = run_batch(client, rows, GROUP, STORES, "test", batch_texts=True, max_cost=0.055)
    assert client.batches == [["m0", "m1"], ["t0-el", "t0-hr", "t1-el", "t1-hr"]]
    gr = result.products[0].stores["premierparfums"]
    assert gr["body_html"].value.startswith("<p>Το Paco")
    s = result.summary()
    # over the limit is reported, but every step ran: the product stays under the ceiling (limit + 20%)
    assert s["max_cost_usd"] == 0.055 and len(s["over_budget"]) == 2 and not s["skipped"]
    assert set(s["over_budget"][0]["steps"]) >= {"research", "description_en", "text_el", "text_hr"}
    assert all(0.055 < o["cost_usd"] <= 0.066 for o in s["over_budget"])


def test_texts_run_even_past_the_ceiling(rows, monkeypatch):
    """A live product lost its descriptions to the ceiling ($0.11 spent + $0.045 of texts > $0.15): texts are
    the cheapest step and always run; the ceiling only stops the optional image lookup."""
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    client = FakeClient(responder=responder)
    result = run_batch(client, rows, GROUP, STORES, "test", batch_texts=False, max_cost=0.0001)
    p = result.products[0]
    assert "description_en" in p.usage and "texts" not in p.skipped
    assert p.stores["premierparfums"]["body_html"].value


def test_mismatch_keeps_the_found_name_in_the_text_facts():
    """research_mismatch blocks the product via `name`, but the prose still needs the fragrance's name."""
    name = Field(key="name", value="Code Profumo", origin="ai_research", status="ok")
    name.flag("blocked", "Продуктът не съвпада с входа: EAN is the 60 ml bottle", "research_mismatch")
    failed = Field(key="concentration", value="Eau de Parfum", origin="ai_research", status="ok")
    failed.flag("blocked", "other problem", "something_else")
    brand = Field(key="brand", value="Giorgio Armani", origin="ai_research", status="ok")
    research = Research(fields={"brand": brand, "name": name, "concentration": failed}, images=[], raw={})
    assert facts_for_text(research) == {"brand": "Giorgio Armani", "name": "Code Profumo"}


def test_wrong_ean_is_flagged_with_the_right_one_and_the_product_is_built(rows, monkeypatch):
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    good = "3614270581670"
    sources = [{"url": A, "says": good, "supports": True}, {"url": B, "says": good, "supports": True}]

    def wrong_ean(kwargs):
        if kwargs.get("tools"):
            answer = research_answer(
                mismatch="ean", problem="It is the 30 ml EAN.", ean_for_volume={"value": good, "sources": sources}
            )
            return message(answer, urls=[A, B, C], searches=4)
        return responder(kwargs)

    result = run_batch(FakeClient(responder=wrong_ean), rows[:1], GROUP, STORES, "test", batch_texts=False)
    gr = result.products[0].stores["premierparfums"]
    assert gr["name"].status == "ok" and gr["body_html"].value.startswith("<p>Το Paco")
    code = gr["ean"]
    assert code.value == rows[0].ean and code.status == "suggested" and code.rule == "ean_mismatch"
    assert code.alternatives == [good] and len(code.sources) == 2
    assert "30 ml EAN" in code.message and good in code.message


def test_a_store_with_a_profile_gets_its_own_text(rows, monkeypatch):
    """PremierParfums has an accepted profile with example descriptions: its text is written in its own
    style (one call for the store), Parfemija without one gets the Croatian translation."""
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    profile = {
        "items": {
            "description_examples": {"value": [{"title": "X", "body_html": "<p>Α.</p><p>Β.</p>"}]},
            "description_html": {"value": "2 × <p>", "status": "ok"},
            "description_length": {"value": [100, 900], "status": "ok"},
        }
    }
    client = FakeClient(responder=responder)
    result = run_batch(client, rows[:1], GROUP, STORES, "test", profiles={"premierparfums": profile})
    systems = [c["system"] for c in client.calls if not c.get("tools")]
    assert sum('"PremierParfums' in s for s in systems) == 1 and not any("into Greek" in s for s in systems)
    gr, hr = result.products[0].stores["premierparfums"], result.products[0].stores["parfemija"]
    assert gr["body_html"].value.count("<p>") == 2
    assert "description_length" not in [i["rule"] for i in gr["body_html"].issues]  # the store's 100–900
    assert hr["body_html"].value.startswith("<p>") and HR[:30] in hr["body_html"].value
