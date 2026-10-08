"""Filling one store's catalog from another's: the same EAN in two audits; the empty picture and description
come from the other store (picture composed for this store, description translated) after approval."""

import csv

import pytest
from sqlalchemy import delete
from sqlalchemy.orm import Session

from db import crosssync, live, review
from db.models import Batch, Event
from db.repo import engine, save_audit
from pipeline.config import load_group
from pipeline.export import load_export
from pipeline.validate import audit as run_audit
from tests.conftest import FIXTURES, png
from tests.fake_ai import FakeClient, message

pytestmark = pytest.mark.db
GROUP = load_group("group-1")


@pytest.fixture
def audits(tmp_path):
    with (FIXTURES / "premierparfums_export.csv").open(encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        header = reader.fieldnames
        rows = [r for r in reader if r["Variant SKU"].startswith("SK") and r["Image Src"] and r["Body (HTML)"]][:2]
    ids = []
    for store, blank in (("premierparfums", False), ("parfemija", True)):
        path = tmp_path / f"{store}.csv"
        with path.open("w", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=header)
            writer.writeheader()
            for r in rows:
                writer.writerow({**r, "Image Src": "", "Body (HTML)": ""} if blank else r)
        ids.append(save_audit(run_audit(load_export(path), GROUP, store)))
    yield ids
    with Session(engine()) as session, session.begin():
        session.execute(delete(Event).where(Event.batch_id.in_(ids)))
        session.execute(delete(Batch).where(Batch.id.in_(ids)))


def test_empty_picture_and_description_come_from_the_other_store(audits):
    _, target = audits
    opts = {k["kind"]: k for k in crosssync.options(target)["kinds"]}
    assert opts["image"]["products"] == 2 and opts["body_html"]["products"] == 2
    assert opts["image"]["from"] == ["PremierParfums (1-GR)"]

    client = FakeClient(responder=lambda kw: message({"html": "<p>Prevedeni opis.</p>"}))
    result, _ = crosssync.run(target, ["image", "body_html"], "Мария", client, fetch=lambda url: png(1200, 1200))
    assert result["Снимка"] == "2 попълнени" and result["Описание"] == "2 попълнени"
    product = review.get_batch(target)["products"][0]
    fields = product["stores"]["parfemija"]["fields"]
    assert (
        fields["image"]["value"].startswith("/api/media/") and fields["body_html"]["value"] == "<p>Prevedeni opis.</p>"
    )
    assert "От premierparfums" in fields["body_html"]["message"]
    keys = [c["key"] for c in live.changes(product["id"])["changes"]]
    assert "image" in keys and "body_html" in keys  # ready for „Обнови в магазина“
    # and live: the picture is staged and added as media, the description written
    from pipeline.shopify import Shopify
    from tests.fake_shopify import FakeShopify

    handle = fields["handle"]["value"]
    fake = FakeShopify(
        [{"id": "gid://shopify/Product/9", "handle": handle, "title": "x", "sku": fields["sku"]["value"]}]
    )
    state = live.push(
        product["id"], "Мария", Shopify("hr.myshopify.com", "tok", http=fake.client(), sleep=lambda s: None)
    )
    assert state["live_status"] == "uploaded", state
    assert fake.media_added and fake.media_added[0][0]["originalSource"].startswith("https://staging.example/")
    assert fake.updates[0]["descriptionHtml"] == "<p>Prevedeni opis.</p>"
