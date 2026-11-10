"""The product list across stores: the same EAN in two store catalogs is one entry, each store with its state."""

import csv

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlalchemy.orm import Session

from api.main import app
from db import catalog, review
from db.models import Batch, Event, FieldRow, Product
from db.repo import engine, save_audit
from pipeline.config import load_group
from pipeline.export import load_export
from pipeline.validate import audit as run_audit
from tests.conftest import FIXTURES

pytestmark = pytest.mark.db
GROUP = load_group("group-1")


@pytest.fixture
def audits(tmp_path):
    with (FIXTURES / "premierparfums_export.csv").open(encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        header = reader.fieldnames
        rows = [r for r in reader if r["Variant SKU"].startswith("SK") and r["Image Src"] and r["Body (HTML)"]][:2]
    ids = []
    for store, take in (("premierparfums", rows), ("parfemija", rows[:1])):
        path = tmp_path / f"{store}.csv"
        with path.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=header)
            writer.writeheader()
            writer.writerows(take)
        ids.append(save_audit(run_audit(load_export(path), GROUP, store)))
    yield ids, [r["Variant SKU"][2:] for r in rows]
    with Session(engine()) as session, session.begin():
        session.execute(delete(Event).where(Event.batch_id.in_(ids)))
        session.execute(delete(Batch).where(Batch.id.in_(ids)))


def _entry(data: dict, ean: str) -> dict:
    return next(e for e in data["items"] if e["ean"] == ean)


def test_one_entry_per_ean_with_every_store(audits):
    (gr, hr), (shared, only_gr) = audits
    data = catalog.catalog(q=shared)
    entry = _entry(data, shared)
    assert set(entry["stores"]) == {"premierparfums", "parfemija"}
    assert {s["batch_id"] for s in entry["stores"].values()} == {gr, hr}
    assert all(s["state"] in ("live", "diff", "bad") for s in entry["stores"].values())  # audit fixes wait as diff

    alone = _entry(catalog.catalog(q=only_gr), only_gr)
    assert set(alone["stores"]) == {"premierparfums"} and alone["missing"] >= 1
    assert catalog.catalog(q=only_gr, filter="missing")["found"] == 1


def test_a_change_made_here_shows_as_waiting_for_the_store(audits):
    (_, hr), (shared, _) = audits
    product = review.get_batch(hr)["products"][0]
    vendor = product["stores"]["parfemija"]["fields"]["vendor"]
    review.decide(vendor["id"], "edit", "Мария", "Нова марка")
    entry = _entry(catalog.catalog(q=shared, filter="todo"), shared)
    assert entry["stores"]["parfemija"]["state"] == "diff"


def test_search_by_words_and_the_api(audits):
    (gr, _), (shared, _) = audits
    entry = _entry(catalog.catalog(q=shared), shared)
    words = entry["title"].split()[:2]
    assert any(e["ean"] == shared for e in catalog.catalog(q=" ".join(w.lower() for w in words))["items"])

    client = TestClient(app)
    body = client.get("/api/catalog", params={"q": shared}).json()
    assert body["found"] == 1 and {"premierparfums", "parfemija"} <= {s["key"] for s in body["stores"]}
    pid = entry["stores"]["premierparfums"]["product_id"]
    assert client.get(f"/api/products/{pid}/catalog").json()["ean"] == shared
    assert client.get("/api/products/999999999/catalog").status_code == 404


def test_without_an_ean_the_same_title_is_one_product(audits):
    (gr, hr), _ = audits
    for batch_id, store in ((gr, "premierparfums"), (hr, "parfemija")):
        product = review.get_batch(batch_id)["products"][0]
        review.decide(product["stores"][store]["fields"]["title"]["id"], "edit", "Мария", "Тест Без Код 50 ml")
        with Session(engine()) as session, session.begin():
            session.get(Product, product["id"]).ean = None
            session.execute(
                delete(FieldRow).where(
                    FieldRow.store_product_id == product["stores"][store]["store_product_id"], FieldRow.key == "ean"
                )
            )
    found = catalog.catalog(q="тест без код")["items"]
    assert len(found) == 1 and set(found[0]["stores"]) == {"premierparfums", "parfemija"}
