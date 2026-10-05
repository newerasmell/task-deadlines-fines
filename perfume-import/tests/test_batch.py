"""A whole batch with the fake client: research once, texts per language, fields per store, validation, DB."""

import pytest
from sqlalchemy import delete
from sqlalchemy.orm import Session

from pipeline.batch import run_batch
from pipeline.config import load_group
from pipeline.input import read_input
from pipeline.settings import ROOT
from tests.fake_ai import FakeClient, message
from tests.test_generate import EL, EN, HR, SEO, text
from tests.test_research import A, B, C, research_answer

GROUP = load_group("group-1")
STORES = ["premierparfums", "parfemija"]


def responder(kwargs):
    if kwargs["tools"]:  # research
        return message(research_answer(), urls=[A, B, C], searches=4)
    system = kwargs["system"]
    if "into Greek" in system:
        return text(EL, notes=[{"en": t, "local": f"{t}-el"} for t in ["sicilian lemon", "rose", "vanilla"]])
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
    research_calls = [c for c in client.calls if c["tools"]]
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
    assert gr["image"].status == "suggested"
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
    assert not [c for c in client.calls if c["tools"]]
    assert second.products[0].reused_research and "research" not in second.products[0].usage


@pytest.mark.db
def test_batch_is_saved(rows, monkeypatch):
    from db.models import Batch, Event
    from db.repo import batch_counts, engine, find_research, save_batch

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
    finally:
        with Session(engine()) as session, session.begin():
            session.execute(delete(Event).where(Event.batch_id == batch_id))
            session.execute(delete(Batch).where(Batch.id == batch_id))
