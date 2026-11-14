"""„Попълни липсващото“: only the empty or blocked facts, from a linked page; notes translated per store; the
EAN only offered; nothing else changed."""

import threading

import pytest
from sqlalchemy import delete
from sqlalchemy.orm import Session

from db import fill, review
from db.models import Batch, Event
from db.newbatch import job
from db.repo import engine, save_batch
from pipeline.batch import run_batch
from pipeline.input import read_input
from pipeline.settings import ROOT
from tests.fake_ai import FakeClient, message
from tests.test_batch import GROUP, STORES, responder

pytestmark = pytest.mark.db
PAGE = "https://www.fragrantica.com/perfume/Hermes/L-Ambre-des-Merveilles-1.html"


@pytest.fixture
def product(monkeypatch):
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    monkeypatch.setattr("pipeline.fill.load_glossary", lambda lang: {"amber": "κεχριμπάρι"} if lang == "el" else {})
    monkeypatch.setattr("db.images._public_url", lambda url: url)  # no DNS in tests
    rows = read_input(ROOT / "input" / "sample-5.csv", GROUP, STORES)[:1]
    batch_id = save_batch(run_batch(FakeClient(responder=responder), rows, GROUP, STORES, "fill test"))
    p = review.get_batch(batch_id)["products"][0]
    with Session(engine()) as session, session.begin():  # the case seen live: top and middle notes empty
        from db.models import FieldRow, StoreProduct

        for sp in session.query(StoreProduct).filter(StoreProduct.product_id == p["id"]):
            for row in session.query(FieldRow).filter(
                FieldRow.store_product_id == sp.id, FieldRow.key.in_(["top_note", "middle_note"])
            ):
                row.value, row.value_en, row.status = "", "", "warning"
    yield p
    with Session(engine()) as session, session.begin():
        session.execute(delete(Event).where(Event.batch_id == batch_id))
        session.execute(delete(Batch).where(Batch.id == batch_id))


def answer(kwargs):
    if kwargs.get("tools"):
        props = kwargs["output_config"]["format"]["schema"]["properties"]
        data = {k: {"value": [] if k.endswith("_note") else "", "sources": []} for k in props}
        src = [{"url": PAGE, "says": "Middle notes: amber, labdanum", "supports": True}]
        data["middle_note"] = {"value": ["amber", "labdanum"], "sources": src}
        return message(data, urls=[PAGE])
    return (
        message({"notes": [{"en": "labdanum", "local": "λάδανο"}]})
        if "Greek" in kwargs["system"]
        else message({"notes": [{"en": "labdanum", "local": "labdanum"}, {"en": "amber", "local": "jantar"}]})
    )


def test_missing_notes_are_filled_from_a_linked_page(product):
    missing = fill.missing(product["id"])
    assert {"top_note", "middle_note"} <= set(missing["keys"]) and "vendor" not in missing["keys"]
    client = FakeClient(responder=answer)
    job_id = fill.start(product["id"], PAGE, "Мария", client=client)
    next(t for t in threading.enumerate() if t.name == f"fill-{job_id}").join(timeout=60)
    state = job(job_id)
    assert state["error"] is None, state
    research = client.calls[0]
    # a link that may refuse to open (Fragrantica): the page first, a search by its perfume's name as a fallback
    assert [t["name"] for t in research["tools"]] == ["web_search", "web_fetch"]
    assert PAGE in research["messages"][0]["content"]
    assert "L Ambre des Merveilles" in research["messages"][0]["content"]
    after = review.get_product(product["id"])["stores"]
    gr, hr = after["premierparfums"]["fields"], after["parfemija"]["fields"]
    assert gr["middle_note"]["value"] == "κεχριμπάρι, λάδανο" and gr["middle_note"]["value_en"] == "amber, labdanum"
    assert hr["middle_note"]["value"] == "jantar, labdanum"
    assert gr["middle_note"]["status"] == "suggested" and "fragrantica" in gr["middle_note"]["message"]
    assert gr["top_note"]["value"] == ""  # the page has no top notes: left empty, not invented
    assert state["result"]["top_note"] == "не е намерено"
    assert gr["vendor"]["value"] == product["stores"]["premierparfums"]["fields"]["vendor"]["value"]  # untouched


def test_pasted_notes_are_synced_to_every_store_in_its_language(product):
    """Copy-pasted „Black Tea (rich, green, and slightly bitter opening)“ -> black tea, in Greek and Croatian."""

    def ai(kwargs):
        system = kwargs["system"]
        if "Extract the perfume notes" in system:
            return message({"notes": ["Black Tea", "bergamot"]})
        if "Greek" in system:
            return message(
                {"notes": [{"en": "black tea", "local": "μαύρο τσάι"}, {"en": "bergamot", "local": "περγαμόντο"}]}
            )
        return message({"notes": [{"en": "black tea", "local": "crni čaj"}, {"en": "bergamot", "local": "bergamot"}]})

    top = product["stores"]["premierparfums"]["fields"]["top_note"]
    after = fill.sync_notes(
        top["id"], "Black Tea (rich, green, and slightly bitter opening), Bergamot", "Мария", FakeClient(responder=ai)
    )
    gr, hr = after["stores"]["premierparfums"]["fields"]["top_note"], after["stores"]["parfemija"]["fields"]["top_note"]
    assert gr["value"] == "μαύρο τσάι, περγαμόντο" and gr["value_en"] == "black tea, bergamot"
    assert hr["value"] == "crni čaj, bergamot" and hr["status"] == "ok" and hr["decided_by"] == "Мария"


def test_a_missing_description_is_written_from_the_current_facts(product):
    """A live product lost its descriptions to the cost ceiling: „Попълни липсващото“ writes them."""
    from db.models import FieldRow, StoreProduct

    with Session(engine()) as session, session.begin():
        for sp in session.query(StoreProduct).filter(StoreProduct.product_id == product["id"]):
            for row in session.query(FieldRow).filter(
                FieldRow.store_product_id == sp.id, FieldRow.key.in_(["body_html", "seo_description"])
            ):
                row.value, row.status = "", "blocked"
    assert "body_html" in fill.missing(product["id"])["keys"]
    client = FakeClient(responder=responder)
    summary, cost = fill.run(product["id"], ["body_html"], None, "Мария", client)
    assert not [c for c in client.calls if c.get("tools")]  # no research: the facts are already there
    assert summary["body_html"] == "написано за 2 магазина"
    after = review.get_product(product["id"])["stores"]
    for store in STORES:
        body = after[store]["fields"]["body_html"]
        assert body["value"].startswith("<p>") and body["status"] in ("suggested", "warning")


def test_a_field_accepted_empty_is_not_missing(product):
    """Ingredients accepted empty by a person (many stores publish none) no longer count as missing."""
    for store in STORES:
        f = review.get_product(product["id"])["stores"][store]["fields"]["ingredients"]
        if f["status"] != "ok":
            review.decide(f["id"], "accept", "Мария")
    assert "ingredients" not in fill.missing(product["id"])["keys"]


def test_a_too_short_description_can_be_rewritten(product):
    """A description flagged by a rule (too short) counts as missing, is rewritten as a suggestion, and the
    store's text stays as the reference until it goes live."""
    from db.models import FieldRow, StoreProduct

    with Session(engine()) as session, session.begin():
        for sp in session.query(StoreProduct).filter(StoreProduct.product_id == product["id"]):
            row = session.query(FieldRow).filter(FieldRow.store_product_id == sp.id, FieldRow.key == "body_html").one()
            row.value, row.previous, row.status = "<p>Кратко.</p>", "<p>Кратко.</p>", "warning"
    assert "body_html" in fill.missing(product["id"])["keys"]
    fill.run(product["id"], ["body_html"], None, "Мария", FakeClient(responder=responder))
    for store in STORES:
        body = review.get_product(product["id"])["stores"][store]["fields"]["body_html"]
        assert body["value"] != "<p>Кратко.</p>" and body["previous"] == "<p>Кратко.</p>"


def test_one_field_by_name_is_rewritten_even_when_it_looks_fine(product):
    before = {s: review.get_product(product["id"])["stores"][s]["fields"]["body_html"]["value"] for s in STORES}
    with Session(engine()) as session, session.begin():  # every store's description passes its rules
        from db.models import FieldRow, StoreProduct

        for sp in session.query(StoreProduct).filter(StoreProduct.product_id == product["id"]):
            for row in session.query(FieldRow).filter(FieldRow.store_product_id == sp.id, FieldRow.key == "body_html"):
                row.status, row.value = "ok", "<p>Стар текст.</p>"
    summary, _ = fill.run(product["id"], ["body_html"], None, "Мария", FakeClient(responder=responder))
    assert summary["body_html"] == "написано за 2 магазина"
    assert before  # the stores had texts; now each has a new suggestion
    for store in STORES:
        assert (
            review.get_product(product["id"])["stores"][store]["fields"]["body_html"]["value"] != "<p>Стар текст.</p>"
        )


def test_a_store_catalog_product_gets_its_name_from_the_title():
    """A product read from a store has a title but no name or concentration field."""
    from db.fill import _facts
    from db.models import FieldRow

    fields = {
        "title": FieldRow(key="title", value="Tom Ford Fucking Fabulous EDP 100 ml", status="ok"),
        "vendor": FieldRow(key="vendor", value="Tom Ford", status="ok"),
        "top_note": FieldRow(key="top_note", value="λεβάντα, λουίζα", value_en=None, status="ok"),
    }
    facts = _facts(fields)
    assert facts["name"] == "Fucking Fabulous" and facts["concentration"] == "Eau de Parfum"
    assert facts["brand"] == "Tom Ford" and facts["top_note"] == ["λεβάντα", "λουίζα"]


def test_one_right_store_is_spread_to_the_others(product, monkeypatch):
    """„Пренеси към всички“: the family, notes (translated) and a new description reach the other store."""
    from db.models import FieldRow, StoreProduct

    words = {"el": {"amber": "κεχριμπάρι", "musk": "μόσχος"}, "hr": {"amber": "jantar", "musk": "mošus"}}
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: words.get(lang, {}))

    with Session(engine()) as session, session.begin():
        sp = (
            session.query(StoreProduct)
            .filter(StoreProduct.product_id == product["id"], StoreProduct.store_key == "parfemija")
            .one()
        )
        for row in session.query(FieldRow).filter(FieldRow.store_product_id == sp.id):
            if row.key == "fragrance_family":
                row.value, row.status = "Woody", "ok"
            if row.key == "base_note":
                row.value, row.value_en, row.status = "jantar, mošus", "amber, musk", "ok"

    def answers(kwargs):
        if "Translate perfume note names" in str(kwargs.get("system", "")):
            return message({"notes": [{"en": "musk", "local": "μόσχος"}]})
        return responder(kwargs)

    summary, _ = fill.spread(product["id"], "parfemija", "Мария", FakeClient(responder=answers))
    assert summary["Пренесено"] == "от parfemija към 1 магазина"
    gr = review.get_product(product["id"])["stores"]["premierparfums"]["fields"]
    assert gr["fragrance_family"]["value"] == "Woody" and gr["fragrance_family"]["decided_by"] == "Мария"
    assert gr["base_note"]["value"] == "κεχριμπάρι, μόσχος" and gr["base_note"]["value_en"] == "amber, musk"
    body = gr["body_html"]  # written again (the fake writes the same words), as a suggestion
    assert body["origin"] == "ai_generated" and body["status"] in ("suggested", "warning"), body["issues"]
    hr = review.get_product(product["id"])["stores"]["parfemija"]["fields"]
    assert hr["base_note"]["value"] == "jantar, mošus"  # the source is left as it is
