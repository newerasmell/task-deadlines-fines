"""New batch from the app: input as CSV or pasted from Excel, free check with the cost, the paid run in the
background (fake AI here), progress, and what happens without a key."""

import threading

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlalchemy.orm import Session

from api.main import app
from db import newbatch
from db.models import Batch, Event
from db.repo import engine
from pipeline.input import read_input_text
from pipeline.settings import ROOT
from tests.fake_ai import FakeClient
from tests.test_batch import GROUP, STORES, responder

CSV = (ROOT / "input" / "sample-5.csv").read_text(encoding="utf-8")


def as_tsv(text: str) -> str:
    import csv
    import io

    rows = list(csv.reader(io.StringIO(text)))
    return "\n".join("\t".join(r) for r in rows)


def test_pasted_rows_read_like_the_csv():
    a = read_input_text(CSV, GROUP, STORES)
    b = read_input_text(as_tsv(CSV), GROUP, STORES)
    assert [(r.name, r.ean, r.prices) for r in a] == [(r.name, r.ean, r.prices) for r in b]


@pytest.mark.db
def test_check_shows_problems_and_the_cost():
    broken = CSV.splitlines()
    head, first = broken[0], broken[1].split(",")
    first[1] = "сто"  # ml is not a number
    text = "\n".join([head, ",".join(first), *broken[2:]])
    out = newbatch.check(text, "group-1", STORES)
    assert out["ready"] == len(out["rows"]) - 1
    assert any("ml" in p for p in out["rows"][0]["problems"])
    assert out["estimate"]["products"] == out["ready"] and out["estimate"]["total"] > 0
    # A store with an accepted profile writes its own text; the others share their language's translation.
    est = out["estimate"]
    assert len(est["languages"]) + est["own_texts"] == 2 and set(est["languages"]) <= {"el", "hr"}


@pytest.mark.db
def test_run_in_the_background_and_save(monkeypatch):
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    text = "\n".join(CSV.splitlines()[:3])  # two products
    job_id = newbatch.start(text, "group-1", STORES, client=FakeClient(responder=responder), name="app test")
    # time.sleep is a no-op in tests (conftest): wait for the worker thread itself.
    worker = next(t for t in threading.enumerate() if t.name == f"new-batch-{job_id}")
    worker.join(timeout=120)
    job = newbatch.job(job_id)
    assert newbatch.running() is None and newbatch.latest()["id"] == job_id  # the app keeps showing the last one
    assert TestClient(app).get("/api/jobs/latest").json()["id"] == job_id
    try:
        assert job["error"] is None, job
        assert job["batch_id"] and job["stage"] == "saving", job
        from db.review import get_batch

        batch = get_batch(job["batch_id"])
        assert batch["name"] == "app test" and len(batch["products"]) == 2
    finally:
        with Session(engine()) as session, session.begin():
            session.execute(delete(Event).where(Event.batch_id == job["batch_id"]))
            session.execute(delete(Batch).where(Batch.id == job["batch_id"]))


@pytest.mark.db
def test_api_without_a_key_says_what_to_add(monkeypatch):
    monkeypatch.delenv("PERFUME_ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    client = TestClient(app)
    form = {"group": "group-1", "stores": ",".join(STORES), "text": CSV}
    checked = client.post("/api/batches/check", data=form)
    assert checked.status_code == 200 and checked.json()["api_key"] is False
    started = client.post("/api/batches/start", data=form)
    assert started.status_code == 409 and "ANTHROPIC_API_KEY" in started.json()["detail"]
    template = client.get("/api/groups/group-1/input-template.csv")
    assert template.text.startswith("name,ml,tester,ean,price_premierparfums")
    assert any(g["key"] == "group-1" and g["ready"] for g in client.get("/api/groups").json())
    assert client.post("/api/batches/check", data={"group": "group-1"}).status_code == 422


def test_names_only_reads_volume_tester_and_ean_from_the_line():
    from pipeline.input import read_names_text

    rows = read_names_text(
        "Dior Sauvage EDT 100 ml TESTER\nArmani Code Profumo EDP 110ml 3614270581670\n\nGucci Bamboo EDP\n",
        GROUP,
        STORES,
    )
    assert [(r.name, r.ml, r.tester, r.ean) for r in rows] == [
        ("Dior Sauvage EDT", 100.0, True, ""),
        ("Armani Code Profumo EDP", 110.0, False, "3614270581670"),
        ("Gucci Bamboo EDP", None, False, ""),
    ]
    assert rows[2].problems and "обем" in rows[2].problems[0]
    assert rows[0].prices == {"premierparfums": None, "parfemija": None}


@pytest.mark.db
def test_product_by_name_gets_the_sourced_ean_to_pick_and_the_sku_follows(monkeypatch):
    """CLAUDE.md #6: no EAN is filled in by the AI; the sourced one is offered, a person picks it, SKU follows."""
    from db import review
    from db.repo import save_batch
    from pipeline.batch import run_batch
    from pipeline.input import read_names_text
    from tests.fake_ai import message
    from tests.test_research import A, B, C, research_answer

    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    found = {"value": "3614270581670", "sources": [{"url": A, "says": "EAN 3614270581670", "supports": True}]}

    def by_name(kwargs):
        if kwargs.get("tools"):
            return message(research_answer(ean_for_volume=found), urls=[A, B, C], searches=3)
        return responder(kwargs)

    rows = read_names_text("Paco Rabanne Lady Million Empire EDP 80 ml", GROUP, STORES)
    result = run_batch(FakeClient(responder=by_name), rows, GROUP, STORES, "by name")
    ean_field = result.products[0].stores["premierparfums"]["ean"]
    assert ean_field.status == "blocked" and ean_field.value == ""
    assert ean_field.alternatives == ["3614270581670"] and "3614270581670" in ean_field.message
    assert result.products[0].stores["premierparfums"]["price"].status == "warning"  # set in Shopify (#16)

    batch_id = save_batch(result)
    try:
        product = review.get_batch(batch_id)["products"][0]
        ean_row = product["stores"]["premierparfums"]["fields"]["ean"]
        after = review.decide(ean_row["id"], "pick", "Мария", "3614270581670")
        for store in STORES:
            fields = after["stores"][store]["fields"]
            assert fields["ean"]["value"] == "3614270581670" and fields["ean"]["status"] == "ok"
            assert fields["sku"]["value"] == "SK3614270581670" and fields["sku"]["status"] == "ok"
    finally:
        with Session(engine()) as session, session.begin():
            session.execute(delete(Event).where(Event.batch_id == batch_id))
            session.execute(delete(Batch).where(Batch.id == batch_id))


@pytest.mark.db
def test_fast_texts_skip_the_batches_queue(monkeypatch):
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    text = "\n".join(CSV.splitlines()[:2])
    cheap = newbatch.check(text, "group-1", STORES)["estimate"]["total"]
    assert newbatch.check(text, "group-1", STORES, fast=True)["estimate"]["total"] > cheap
    client = FakeClient(responder=responder)
    job_id = newbatch.start(text, "group-1", STORES, client=client, name="fast test", fast=True)
    next(t for t in threading.enumerate() if t.name == f"new-batch-{job_id}").join(timeout=120)
    job = newbatch.job(job_id)
    try:
        assert job["error"] is None and job["fast"] and job["finished_at"] >= job["started_at"]
        assert client.batches == []  # no Message Batch: every text was a direct call
    finally:
        with Session(engine()) as session, session.begin():
            session.execute(delete(Event).where(Event.batch_id == job["batch_id"]))
            session.execute(delete(Batch).where(Batch.id == job["batch_id"]))
