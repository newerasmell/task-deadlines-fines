"""Stores in the app: upload a catalog, get a profile and a group recommendation, accept it (audit), versions."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlalchemy.orm import Session

from db import stores
from db.models import Batch, Event, Store, StoreProfile
from db.repo import engine
from pipeline import config
from pipeline.batch import run_batch
from pipeline.config import load_group
from pipeline.input import read_input
from pipeline.settings import ROOT
from tests.conftest import FIXTURES
from tests.fake_ai import FakeClient
from tests.test_batch import GROUP, STORES, responder

KEY = "parfemijatest"


@pytest.fixture
def clean(monkeypatch):
    monkeypatch.setattr(config, "store_overrides", None)
    stores.install()
    yield
    with Session(engine()) as session, session.begin():
        ids = [b for (b,) in session.query(Batch.id).filter(Batch.store_key == KEY).all()]
        session.execute(delete(Event).where(Event.batch_id.in_(ids)))
        session.execute(delete(Batch).where(Batch.id.in_(ids)))
        session.execute(delete(StoreProfile).where(StoreProfile.store_key == KEY))
        session.execute(delete(Store).where(Store.key == KEY))
        row = session.get(Store, "premierparfums")
        if row is not None:
            row.settings, row.shop_domain = {}, None


def upload(name="Parfemija Test (1-HR)", **kw) -> int:
    data = (FIXTURES / "parfemija_export.csv").read_bytes()
    return stores.analyze(data, "products_export_hr.csv", name=name, **kw)


@pytest.mark.db
def test_new_store_gets_a_profile_and_a_group_recommendation(clean):
    profile_id = upload()
    p = stores.get_profile(profile_id)
    assert p["store"] == KEY and p["state"] == "proposed" and p["version"] == 1 and p["diff"]["first"]
    # 84% of Parfemija's descriptions are English (decisions #1): detection says so, the person corrects it.
    assert p["profile"]["items"]["content_language"]["value"] == "en"
    scores = p["profile"]["group_scores"]
    assert scores[0]["group"] == "group-1" and scores[0]["recommended"] and scores[0]["score"] >= 0.8
    assert any(s["group"] == "group-2" and not s["comparable"] for s in scores)
    assert scores[-1]["group"] is None and not scores[-1]["recommended"]
    listed = next(s for s in stores.list_stores() if s["key"] == KEY)
    assert listed["state"] == "proposed" and listed["group"] is None and listed["products"] == p["profile"]["products"]

    stores.update_item(profile_id, "content_language", "hr", "Мария")
    edited = stores.update_item(profile_id, "handle", "slug(title)", "Мария")
    assert edited["profile"]["items"]["handle"]["status"] == "accepted"
    assert "handle" not in edited["profile"]["to_confirm"]

    with pytest.raises(stores.StoreError, match="/new-group"):
        stores.accept(profile_id, None, "Мария")
    accepted = stores.accept(profile_id, "group-1", "Мария")
    assert accepted["state"] == "accepted" and accepted["audit_batch_id"]
    group = load_group("group-1")
    assert KEY in group.stores and group.stores[KEY].language == "hr"  # from the database, not stores.yaml
    listed = next(s for s in stores.list_stores() if s["key"] == KEY)
    assert listed["state"] == "active" and listed["group"] == "group-1" and listed["audit_batch_id"]

    # Updating the catalog: a new version with the differences.
    second = stores.get_profile(upload(name="", store_key=KEY))
    assert second["version"] == 2 and second["diff"]["first"] is False
    with pytest.raises(stores.StoreError, match="вече има"):
        upload(name="Parfemija Test (1-HR)")


@pytest.mark.db
def test_shop_domain_set_in_the_app(clean):
    with pytest.raises(stores.StoreError, match="myshopify.com"):
        stores.set_shop("premierparfums", "premierparfums.gr", "Мария")
    stores.set_shop("premierparfums", "https://premier-parfums.myshopify.com/", "Мария")
    assert load_group("group-1").stores["premierparfums"].shop == "premier-parfums.myshopify.com"


@pytest.mark.db
def test_api_upload_and_accept(clean):
    from api.main import app

    client = TestClient(app)
    with (FIXTURES / "parfemija_export.csv").open("rb") as fh:
        response = client.post(
            "/api/stores/analyze",
            files={"file": ("export.csv", fh, "text/csv")},
            data={"name": "Parfemija Test (1-HR)"},
        )
    assert response.status_code == 201, response.text
    profile_id = response.json()["profile_id"]
    assert client.get(f"/api/profiles/{profile_id}").json()["store"] == KEY
    bad = client.post("/api/stores/analyze", files={"file": ("x.txt", b"hello", "text/plain")}, data={"name": "X"})
    assert bad.status_code == 409 and ".csv" in bad.json()["detail"]
    assert client.post(f"/api/profiles/{profile_id}/accept", json={"group": "group-1"}).status_code == 200
    assert any(s["key"] == KEY for s in client.get("/api/stores").json())


def test_new_products_follow_the_store_profile(monkeypatch):
    """CLAUDE.md principle 1: the accepted profile's title formula wins over the group's."""
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    rows = read_input(ROOT / "input" / "sample-5.csv", GROUP, STORES)[:1]
    profile = {"items": {"title_pattern": {"value": "{brand} {name} {ml} ml{tester: ' TESTER'}", "status": "accepted"}}}
    result = run_batch(FakeClient(responder=responder), rows, GROUP, STORES, "t", profiles={"parfemija": profile})
    hr, gr = result.products[0].stores["parfemija"], result.products[0].stores["premierparfums"]
    assert "EDP" in gr["title"].value and "EDP" not in hr["title"].value
