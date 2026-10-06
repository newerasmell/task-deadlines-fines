import pytest
from sqlalchemy import delete
from sqlalchemy.orm import Session

from db.models import Batch, Event
from db.repo import batch_counts, engine, save_audit
from pipeline.config import load_group
from pipeline.export import load_export
from pipeline.validate import audit
from tests.conftest import FIXTURES


@pytest.mark.db
def test_audit_is_saved_with_every_field():
    report = audit(load_export(FIXTURES / "parfemija_export.csv"), load_group("group-1"), "parfemija")
    batch_id = save_audit(report)
    try:
        expected = report.summary()["fields_by_status"]
        assert batch_counts(batch_id) == {k: v for k, v in expected.items() if v}
    finally:
        with Session(engine()) as session, session.begin():
            session.execute(delete(Event).where(Event.batch_id == batch_id))
            session.execute(delete(Batch).where(Batch.id == batch_id))  # products, fields cascade
