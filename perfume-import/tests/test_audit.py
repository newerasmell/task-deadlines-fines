"""Audit in the app: findings by rule, the products behind them, and the fix CSV for Shopify's import."""

import csv
import io

import pytest
from sqlalchemy import delete
from sqlalchemy.orm import Session

from db import audit, review
from db.models import Batch, Event
from db.repo import engine, save_audit
from pipeline.config import load_group
from pipeline.export import load_export
from pipeline.validate import audit as run_audit
from tests.conftest import FIXTURES

pytestmark = pytest.mark.db
GROUP = load_group("group-1")


@pytest.fixture
def batch(tmp_path):
    """Three real products from the GR export: the first gets a gender variant, the third a compare-at equal
    to the price."""
    with (FIXTURES / "premierparfums_export.csv").open(encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        header = reader.fieldnames
        rows = []
        for row in reader:
            ratio_ok = row["Variant Price"] and row["Variant Compare At Price"]
            if row["Variant SKU"].startswith("SK") and ratio_ok and row["Gender (product.metafields.custom.gender)"]:
                rows.append(row)
            if len(rows) == 3:
                break
    rows[0]["Gender (product.metafields.custom.gender)"] = "Womens perfume"
    rows[2]["Variant Compare At Price"] = rows[2]["Variant Price"]
    path = tmp_path / "small_export.csv"
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=header)
        writer.writeheader()
        writer.writerows(rows)
    batch_id = save_audit(run_audit(load_export(path), GROUP, "premierparfums"))
    yield batch_id, rows
    with Session(engine()) as session, session.begin():
        session.execute(delete(Event).where(Event.batch_id == batch_id))
        session.execute(delete(Batch).where(Batch.id == batch_id))


def parse(data: bytes) -> list[dict]:
    return list(csv.DictReader(io.StringIO(data.decode("utf-8"))))


def test_findings_by_rule(batch):
    batch_id, rows = batch
    s = audit.summary(batch_id)
    assert s["products"] == 3
    rules = {i["rule"]: i for i in s["issues"]}
    assert rules["compare_at_not_above"]["status"] == "blocked"
    assert rules["compare_at_not_above"]["action"] == "спира, решава човек"
    assert rules["gender_variant"]["action"] == "поправя автоматично"
    assert [i["status"] for i in s["issues"]] == sorted(
        [i["status"] for i in s["issues"]], key=lambda st: -["ok", "fixed", "suggested", "warning", "blocked"].index(st)
    )
    blocked = audit.items(batch_id, "compare_at_not_above")
    assert blocked["total"] == 1 and blocked["items"][0]["price"] == rows[2]["Variant Price"]


def test_fix_csv_has_only_changes_with_full_values(batch):
    batch_id, rows = batch
    name, data = audit.fix_csv(batch_id)
    assert name.endswith(".csv")
    out = parse(data)
    handles = [r["Handle"] for r in out]
    assert rows[0]["Handle"] in handles
    assert "Variant Compare At Price" not in out[0]  # the blocked compare-at never goes out
    first = next(r for r in out if r["Handle"] == rows[0]["Handle"])
    assert first["Gender (product.metafields.custom.gender)"] == "Women's Perfume"
    assert first["Title"]  # required by the import
    assert "Variant Price" not in out[0]  # no price changed: the column is not in the file

    # A person fixes the compare-at price: price columns appear, and every row carries its full current value.
    product = next(p for p in review.get_batch(batch_id)["products"] if p["input"]["handle"] == rows[2]["Handle"])
    compare = product["stores"]["premierparfums"]["fields"]["compare_at"]
    review.decide(compare["id"], "edit", "Мария", f"{float(rows[2]['Variant Price']) * 1.5:.2f}")
    out = parse(audit.fix_csv(batch_id)[1])
    third = next(r for r in out if r["Handle"] == rows[2]["Handle"])
    assert third["Variant Compare At Price"] == f"{float(rows[2]['Variant Price']) * 1.5:.2f}"
    assert third["Option1 Value"] == "Default Title"
    for r in out:
        assert all(r[c] != "" for c in ("Handle", "Title", "Variant Compare At Price") if c in r), r
