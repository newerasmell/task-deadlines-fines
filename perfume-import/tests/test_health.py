import pytest
from fastapi.testclient import TestClient

from api.main import app


@pytest.mark.db
def test_health_reports_db_ok():
    response = TestClient(app).get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "db": "ok"}
