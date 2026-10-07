"""Review in the app: read a batch, decide fields (accept, edit, pick), approve. Needs Postgres."""

from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from api.main import app
from db import review
from db.models import Batch, Event
from db.repo import engine, save_batch
from pipeline.batch import run_batch
from pipeline.input import read_input
from pipeline.settings import ROOT
from tests.fake_ai import FakeClient
from tests.test_batch import GROUP, STORES, responder

pytestmark = pytest.mark.db
ACTOR = "Мария"


@pytest.fixture
def batch(monkeypatch):
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    rows = read_input(ROOT / "input" / "sample-5.csv", GROUP, STORES)[:2]
    batch_id = save_batch(run_batch(FakeClient(responder=responder), rows, GROUP, STORES, "review test"))
    yield review.get_batch(batch_id)
    with Session(engine()) as session, session.begin():
        session.execute(delete(Event).where(Event.batch_id == batch_id))
        session.execute(delete(Batch).where(Batch.id == batch_id))


def fields(product: dict, store: str = "premierparfums") -> dict:
    return product["stores"][store]["fields"]


def test_batch_lists_with_product_states(batch):
    listed = next(b for b in review.list_batches() if b["id"] == batch["id"])
    assert listed["products"] == 2 and listed["kind"] == "new"
    assert [s["key"] for s in listed["stores"]] == STORES
    assert listed["review"] + listed["blocked"] + listed["ready"] == 2
    product = batch["products"][0]
    assert product["title"].startswith("Paco Rabanne Lady Million Empire")
    assert {m["kind"] for m in product["media"]} == {"original", "composed"}
    assert fields(product)["image"]["value"].startswith("/api/media/")


def test_accepting_a_shared_fact_applies_to_every_store(batch):
    product = batch["products"][0]
    family = fields(product)["fragrance_family"]
    assert family["status"] == "suggested"
    after = review.decide(family["id"], "accept", ACTOR)
    for store in STORES:
        f = fields(after, store)["fragrance_family"]
        assert f["status"] == "ok" and f["decided_by"] == ACTOR
    # A localized text is per store.
    body = fields(after)["body_html"]
    after = review.decide(body["id"], "accept", ACTOR)
    assert fields(after, "premierparfums")["body_html"]["status"] == "ok"
    assert fields(after, "parfemija")["body_html"]["status"] == "suggested"


def test_vocab_value_can_be_picked_and_free_text_cannot(batch):
    family = fields(batch["products"][0])["fragrance_family"]
    after = review.decide(family["id"], "pick", ACTOR, "Woody")
    f = fields(after, "parfemija")["fragrance_family"]
    assert f["value"] == "Woody" and f["origin"] == "vocab" and f["previous"] == "Amber Floral"
    assert "Amber Floral" in f["alternatives"]  # the old value stays one click away
    with pytest.raises(review.ReviewError):
        review.decide(family["id"], "pick", ACTOR, "Something Else")


def test_edit_is_validated_with_the_related_field(batch):
    product = batch["products"][0]
    price = fields(product)["price"]
    compare = fields(product)["compare_at"]
    after = review.decide(compare["id"], "edit", ACTOR, price["value"])  # compare-at = price
    assert fields(after)["compare_at"]["status"] == "blocked"
    assert fields(after, "parfemija")["compare_at"]["status"] == "ok"  # prices are per store
    with pytest.raises(review.ReviewError, match="Спряно"):
        review.decide(compare["id"], "accept", ACTOR)
    after = review.decide(price["id"], "edit", ACTOR, "40.00")  # 58 / 40 = 1.45x, inside 1.2-2.5
    assert fields(after)["price"]["status"] == "ok"
    assert fields(after)["compare_at"]["status"] == "ok"


def test_new_ean_rebuilds_the_sku_in_every_store(batch):
    product = batch["products"][0]
    ean = fields(product)["ean"]
    after = review.decide(ean["id"], "edit", ACTOR, "3614270581670")
    for store in STORES:
        f = fields(after, store)
        assert f["ean"]["value"] == "3614270581670" and f["ean"]["status"] == "ok"
        assert f["sku"]["value"] == "SK3614270581670" and f["sku"]["previous"] == "SK3614270581656"
    after = review.decide(ean["id"], "edit", ACTOR, "3614270581671")  # wrong check digit
    assert fields(after)["ean"]["status"] == "blocked"


def test_approve_needs_every_decision_and_a_change_withdraws_it(batch):
    product = batch["products"][0]
    with pytest.raises(review.ReviewError, match="предложения"):
        review.approve(product["id"], ACTOR)
    after = review.accept_all(product["id"], ACTOR)
    assert not any(f["status"] == "suggested" for s in after["stores"].values() for f in s["fields"].values())
    after = review.approve(product["id"], ACTOR)
    assert all(s["approved_by"] == ACTOR for s in after["stores"].values())
    after = review.decide(fields(after)["price"]["id"], "edit", ACTOR, "57.00")
    assert all(s["approved_at"] is None for s in after["stores"].values())


def test_accept_column(batch):
    accepted = review.accept_column(batch["id"], "parfemija", "body_html", ACTOR)
    assert accepted == 2
    again = review.get_batch(batch["id"])
    assert all(fields(p, "parfemija")["body_html"]["status"] == "ok" for p in again["products"])
    assert all(fields(p, "premierparfums")["body_html"]["status"] == "suggested" for p in again["products"])


def test_api_round_trip_with_actor_header(batch):
    client = TestClient(app)
    assert any(b["id"] == batch["id"] for b in client.get("/api/batches").json())
    body = client.get(f"/api/batches/{batch['id']}").json()
    family = fields(body["products"][1])["fragrance_family"]
    response = client.post(
        f"/api/fields/{family['id']}/decision", json={"action": "accept"}, headers={"X-Actor": quote(ACTOR)}
    )
    assert response.status_code == 200
    assert fields(response.json())["fragrance_family"]["decided_by"] == ACTOR
    compare = fields(body["products"][1])["compare_at"]
    client.post(f"/api/fields/{compare['id']}/decision", json={"action": "edit", "value": "1"})
    refused = client.post(f"/api/fields/{compare['id']}/decision", json={"action": "accept"})
    assert refused.status_code == 409 and "Спряно" in refused.json()["detail"]
    assert client.get("/api/batches/999999999").status_code == 404
    assert "Woody" in client.get("/api/groups/group-1/vocab").json()["fragrance_family"]
    with Session(engine()) as session:
        kinds = session.execute(select(Event.kind).where(Event.batch_id == batch["id"])).scalars().all()
        assert "field_accept" in kinds and "field_edit" in kinds


def test_each_store_says_whether_it_can_be_published(batch):
    """The product screen lights a store when it has a template (accepted profile) and Shopify access."""
    for store in batch["stores"]:
        assert set(store) >= {"template", "access"}
        assert store["access"]  # the seed's stores have no domain: what stops the upload is said


def test_store_currency_and_name_come_from_the_group_config(batch):
    """A store row made by a catalog upload can lack its currency and name; the product screen must still show
    the store's own currency (a live CZK store showed EUR and prices were typed in euros)."""
    from db.models import Store

    with Session(engine()) as session, session.begin():
        row = session.get(Store, "parfemija")
        saved = (row.label, row.currency, row.country)
        row.label, row.currency, row.country = "parfemija", None, None
    try:
        stores = {s["key"]: s for s in review.get_batch(batch["id"])["stores"]}
        assert stores["parfemija"]["currency"] == "EUR" and stores["parfemija"]["label"] == "Parfemija (1-HR)"
        listed = next(b for b in review.list_batches() if b["id"] == batch["id"])
        assert {s["key"]: s["country"] for s in listed["stores"]}["parfemija"] == "HR"
    finally:
        with Session(engine()) as session, session.begin():
            row = session.get(Store, "parfemija")
            row.label, row.currency, row.country = saved
