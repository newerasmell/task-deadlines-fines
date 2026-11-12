"""The product list across stores: the same EAN in two store catalogs is one entry, each store with its state."""

import csv

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from api.main import app
from db import catalog, review
from db.models import Batch, Event, FieldRow, Product, StoreProduct
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


def test_a_store_without_the_ean_joins_the_product_by_title(audits):
    (_, hr), (shared, _) = audits
    product = next(p for p in review.get_batch(hr)["products"] if p["ean"] == shared)
    with Session(engine()) as session, session.begin():
        session.get(Product, product["id"]).ean = None
        session.execute(
            delete(FieldRow).where(
                FieldRow.store_product_id == product["stores"]["parfemija"]["store_product_id"], FieldRow.key == "ean"
            )
        )
    entry = _entry(catalog.catalog(q=shared), shared)
    assert set(entry["stores"]) == {"premierparfums", "parfemija"}


def test_fixes_the_rules_made_are_not_changes_waiting(audits):
    (gr, _), _ = audits
    with Session(engine()) as session:
        fixed = (
            session.execute(
                select(Product.ean)
                .join(StoreProduct, StoreProduct.product_id == Product.id)
                .join(FieldRow, FieldRow.store_product_id == StoreProduct.id)
                .where(Product.batch_id == gr, FieldRow.origin == "auto_fix", FieldRow.status == "fixed")
            )
            .scalars()
            .first()
        )
    if fixed is None:
        pytest.skip("the fixture has no automatic fix")
    entry = _entry(catalog.catalog(q=fixed), fixed)
    assert entry["stores"]["premierparfums"]["state"] in ("live", "bad") and entry["fixes"] >= 0
    assert catalog.catalog(q=fixed, filter="fixes")["counts"]["fixes"] >= (
        1 if entry["stores"]["premierparfums"]["state"] == "live" else 0
    )


def _hr_rows(hr: int, ean: str) -> dict:
    product = next(p for p in review.get_batch(hr)["products"] if p["ean"] == ean)
    return product["stores"]["parfemija"]["fields"]


def _set(field_id: int, **values) -> None:
    with Session(engine()) as session, session.begin():
        row = session.get(FieldRow, field_id)
        for k, v in values.items():
            setattr(row, k, v)


def test_a_decant_with_the_bottles_ean_is_another_product(audits):
    """15 ml decants often carry the full bottle's EAN: another volume and another SKU are another product."""
    (_, hr), (shared, _) = audits
    fields = _hr_rows(hr, shared)
    title = fields["title"]["value"]
    _set(fields["title"]["id"], value=title.rsplit(" ", 2)[0] + " 15 ml")
    _set(fields["sku"]["id"], value="DEC-15", previous=None)
    if "product_milliliters" in fields:
        _set(fields["product_milliliters"]["id"], value="15 ml")
    found = [e for e in catalog.catalog(q=shared)["items"] if e["ean"] == shared]
    assert len(found) == 2 and all(len(e["stores"]) == 1 for e in found)


def test_a_new_sku_keeps_the_link_while_the_stores_still_show_the_old(audits):
    """The SKU links first; the store's old SKU (previous) and the new one both count until it is everywhere."""
    (gr, hr), (shared, _) = audits
    fields = _hr_rows(hr, shared)
    old = fields["sku"]["value"]
    _set(fields["sku"]["id"], value="CH-NEW-1", previous=old)  # changed here, the store still shows the old
    with Session(engine()) as session, session.begin():  # and its EAN no longer says it is the same product
        session.get(Product, next(p for p in review.get_batch(hr)["products"] if p["ean"] == shared)["id"]).ean = None
        session.query(FieldRow).filter(FieldRow.id == fields["ean"]["id"]).update({"value": "4006000000000"})
    entry = next(e for e in catalog.catalog(q=shared)["items"] if e["ean"] == shared)
    assert set(entry["stores"]) == {"premierparfums", "parfemija"}


def test_opening_a_product_of_a_store_catalog_loads_only_it(audits):
    (gr, _), _ = audits
    first, second = review.get_batch(gr)["products"][:2]
    batch = review.get_batch(gr, focus=second["id"])
    by_id = {p["id"]: p for p in batch["products"]}
    assert by_id[second["id"]]["stores"]["premierparfums"]["fields"]
    assert by_id[first["id"]]["brief"] and by_id[first["id"]]["stores"]["premierparfums"]["fields"] == {}
    assert sum(by_id[first["id"]]["counts"].values()) > 0
