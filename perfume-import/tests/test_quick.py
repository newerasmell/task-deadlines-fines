"""The quick new product: a name with its volume, an EAN and a price in euros; the free check says what will
be read and what is missing, the run prices every store in its own currency from the euro price."""

import threading

import pytest
from sqlalchemy import delete
from sqlalchemy.orm import Session

from db import newbatch, review
from db.models import Batch, Event
from db.repo import engine
from tests.fake_ai import FakeClient
from tests.test_batch import STORES, responder

pytestmark = pytest.mark.db


def test_the_check_reads_each_line_and_says_what_is_missing():
    out = newbatch.quick_check(
        [
            {"name": "Dior Sauvage EDT 100 ml TESTER", "ean": "3348901250146", "price": "69,00", "compare": "99"},
            {"name": "Dior Sauvage EDT", "ean": "", "price": "", "compare": ""},
            {"name": "  ", "ean": "", "price": "", "compare": ""},  # an empty line is left out
        ],
        STORES,
    )
    first, second = out["rows"]
    assert (first["ml"], first["tester"], first["ean"]) == (100, True, "3348901250146")
    assert (first["price_eur"], first["compare_eur"]) == (69.0, 99.0) and not first["problems"]
    assert any("обем" in p for p in second["problems"])
    assert out["ready"] == 1 and out["estimate"]["total"] > 0


def test_wrong_input_is_said_plainly():
    with pytest.raises(newbatch.NewBatchError, match="поне един продукт"):
        newbatch.quick_check([{"name": ""}], STORES)
    with pytest.raises(newbatch.NewBatchError, match="не е цена"):
        newbatch.quick_check([{"name": "Dior Sauvage EDT 100 ml", "price": "много"}], STORES)
    with pytest.raises(newbatch.NewBatchError, match="поне един магазин"):
        newbatch.quick_check([{"name": "Dior Sauvage EDT 100 ml"}], [])
    out = newbatch.quick_check([{"name": "Dior Sauvage EDT 100 ml", "price": "90", "compare": "80"}], STORES)
    assert any("по-висока" in p for p in out["rows"][0]["problems"])


def test_the_run_prices_every_store_from_the_euro_price(monkeypatch, fixed_rates):
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    job_id = newbatch.quick_start(
        [{"name": "Dior Sauvage EDT 100 ml", "ean": "3348901250146", "price": "69", "compare": "99"}],
        STORES,
        "Мария",
        client=FakeClient(responder=responder),
    )
    worker = next(t for t in threading.enumerate() if t.name == f"new-batch-{job_id}")
    worker.join(timeout=120)
    job = newbatch.job(job_id)
    try:
        assert job["error"] is None and job["batch_id"], job
        assert job.get("result") is None, job  # every price was set
        product = review.get_batch(job["batch_id"])["products"][0]
        for store in STORES:
            fields = product["stores"][store]["fields"]
            assert float(fields["price"]["value"]) == pytest.approx(69, abs=1)
            assert float(fields["compare_at"]["value"]) == pytest.approx(99, abs=1)
            assert fields["price"]["decided_by"] == "Мария"
    finally:
        with Session(engine()) as session, session.begin():
            session.execute(delete(Event).where(Event.batch_id == job["batch_id"]))
            session.execute(delete(Batch).where(Batch.id == job["batch_id"]))


def test_facts_two_live_stores_agree_on_are_not_asked_again(monkeypatch, fixed_rates):
    """Made from live copies (pipeline.unify): no web research, and a fact two stores state is ok."""
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    gr, hr = "https://gr.shop/products/x", "https://hr.shop/products/x"
    both = [{"url": gr, "says": "a", "supports": True}, {"url": hr, "says": "a", "supports": True}]
    fact = lambda value, sources=both: {"value": value, "sources": sources}  # noqa: E731
    research = {
        "brand": fact("Dior"),
        "name": fact("Sauvage"),
        "concentration": fact("Eau de Toilette"),
        "gender": fact("Men's Perfume"),
        "fragrance_family": fact("Woody", both[:1]),
        "top_note": fact(["bergamot"]),
        "middle_note": fact(["pepper"]),
        "base_note": fact(["ambroxan"]),
        "ingredients": fact("", []),
        "images": [{"url": "https://cdn.shopify.com/s/sauvage.png", "width": 0, "height": 0, "source": "live store"}],
        "mismatch": "none",
        "problem": "",
        "ean_for_volume": fact("", []),
        "_sources_seen": [gr, hr],
        "_tier": "economy",
    }
    client = FakeClient(responder=responder)
    job_id = newbatch.quick_start(
        [{"name": "Dior Sauvage EDT 100 ml", "ean": "3348901250146", "price": "69"}],
        STORES,
        "Мария",
        client=client,
        research=research,
    )
    worker = next(t for t in threading.enumerate() if t.name == f"new-batch-{job_id}")
    worker.join(timeout=120)
    job = newbatch.job(job_id)
    try:
        assert job["error"] is None, job
        assert not [c for c in client.calls if c.get("tools")]  # no web research
        fields = review.get_batch(job["batch_id"])["products"][0]["stores"][STORES[0]]["fields"]
        assert fields["gender"]["status"] == "ok" and fields["fragrance_family"]["status"] == "suggested"
    finally:
        with Session(engine()) as session, session.begin():
            session.execute(delete(Event).where(Event.batch_id == job["batch_id"]))
            session.execute(delete(Batch).where(Batch.id == job["batch_id"]))


def test_with_own_pictures_none_is_searched(monkeypatch, fixed_rates):
    """„Снимките ги качвам аз“: no picture is searched or downloaded; the field asks for one."""
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    fetched = []
    monkeypatch.setattr("pipeline.images.fetch", lambda url: fetched.append(url) or b"")
    client = FakeClient(responder=responder)
    job_id = newbatch.quick_start(
        [{"name": "Dior Sauvage EDT 100 ml", "ean": "3348901250146", "price": "69"}],
        STORES,
        "Мария",
        client=client,
        own_images=True,
    )
    worker = next(t for t in threading.enumerate() if t.name == f"new-batch-{job_id}")
    worker.join(timeout=120)
    job = newbatch.job(job_id)
    try:
        assert job["error"] is None, job
        assert fetched == []
        assert not [c for c in client.calls if str(c.get("system", "")).startswith("You find packshot")]
        product = review.get_batch(job["batch_id"])["products"][0]
        image = product["stores"][STORES[0]]["fields"]["image"]
        assert image["status"] == "blocked" and "качваш ти" in image["message"] and not product["media"]
    finally:
        with Session(engine()) as session, session.begin():
            session.execute(delete(Event).where(Event.batch_id == job["batch_id"]))
            session.execute(delete(Batch).where(Batch.id == job["batch_id"]))
