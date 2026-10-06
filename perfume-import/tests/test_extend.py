"""Adding stores to a researched batch: no research is paid again, each new store gets its fields, picture and
text, and what a person already decided for the product is carried over."""

import threading

import pytest
from sqlalchemy import delete
from sqlalchemy.orm import Session

from db import extend, review
from db.models import Batch, Event
from db.repo import engine, save_batch
from pipeline.batch import run_batch
from pipeline.input import read_input
from pipeline.settings import ROOT
from tests.fake_ai import FakeClient
from tests.test_batch import GROUP, responder

pytestmark = pytest.mark.db


@pytest.fixture
def one_store_batch(monkeypatch):
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    rows = read_input(ROOT / "input" / "sample-5.csv", GROUP, ["premierparfums"])[:1]
    result = run_batch(FakeClient(responder=responder), rows, GROUP, ["premierparfums"], "extend test")
    batch_id = save_batch(result, author="test")
    yield batch_id
    with Session(engine()) as session, session.begin():
        session.execute(delete(Event).where(Event.batch_id == batch_id))
        session.execute(delete(Batch).where(Batch.id == batch_id))


def test_a_store_is_added_without_paying_research_again(one_store_batch):
    batch = review.get_batch(one_store_batch)
    product = batch["products"][0]
    vendor = product["stores"]["premierparfums"]["fields"]["vendor"]
    review.decide(vendor["id"], "edit", "Мария", "Rabanne")  # a person's decision on a shared fact

    opts = extend.options(one_store_batch)
    assert opts["present"] == ["premierparfums"] and "parfemija" in [s["key"] for s in opts["stores"]]

    client = FakeClient(responder=responder)
    job_id = extend.start(one_store_batch, ["parfemija"], "test", fast=True, client=client)
    next(t for t in threading.enumerate() if t.name == f"new-batch-{job_id}").join(timeout=120)
    from db.newbatch import job

    state = job(job_id)
    assert state["error"] is None, state
    assert not [c for c in client.calls if c.get("tools")]  # no research call: it is reused
    after = review.get_batch(one_store_batch)
    assert [s["key"] for s in after["stores"]] == ["premierparfums", "parfemija"]
    hr = after["products"][0]["stores"]["parfemija"]["fields"]
    assert hr["vendor"]["value"] == "Rabanne"  # carried over
    assert hr["body_html"]["value"] and hr["title"]["value"]
    assert extend.options(one_store_batch)["present"] == ["premierparfums", "parfemija"]
