"""Team login: first admin on an empty database, sessions, admins create users, everything else needs a login;
Shopify access entered in the app is stored encrypted and never sent back."""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from api.main import app
from db.models import StoreSecret, User, UserSession
from db.repo import engine

pytestmark = pytest.mark.db


@pytest.fixture
def real_login():
    """No logged-in stand-in, and no users: the database starts like a fresh deploy."""
    app.dependency_overrides.clear()
    import api.auth

    api.auth._failures.clear()
    with Session(engine()) as session, session.begin():
        session.execute(delete(UserSession))
        session.execute(delete(User))
        session.execute(delete(StoreSecret))
    yield TestClient(app)
    with Session(engine()) as session, session.begin():
        session.execute(delete(UserSession))
        session.execute(delete(User))
        session.execute(delete(StoreSecret))


def test_everything_needs_a_login_and_the_first_admin_sets_up(real_login):
    c = real_login
    assert c.get("/api/batches").status_code == 401
    assert c.get("/api/health").status_code in (200, 503)
    assert c.get("/api/auth/me").json() == {"user": None, "setup_needed": True}
    assert c.post("/api/auth/setup", json={"name": "Георги", "password": "short"}).status_code == 409
    r = c.post("/api/auth/setup", json={"name": "Георги", "password": "дълга-парола-1"})
    assert r.status_code == 200 and r.json()["user"]["is_admin"] is True
    assert "httponly" in r.headers["set-cookie"].lower()
    assert c.get("/api/batches").status_code == 200  # the cookie is the session
    assert c.get("/api/auth/me").json()["user"]["name"] == "Георги"
    # A second "first admin" is refused once anyone exists.
    other = TestClient(app)
    assert other.post("/api/auth/setup", json={"name": "Чужд", "password": "дълга-парола-2"}).status_code == 409


def test_admin_creates_users_who_log_in_and_cannot_manage_others(real_login):
    c = real_login
    c.post("/api/auth/setup", json={"name": "admin", "password": "дълга-парола-1"})
    created = c.post("/api/auth/users", json={"name": "Мария", "password": "паролата-на-мария"})
    assert created.status_code == 201 and created.json()["is_admin"] is False
    maria = TestClient(app)
    assert maria.post("/api/auth/login", json={"name": "мария", "password": "грешна-парола"}).status_code == 401
    assert maria.post("/api/auth/login", json={"name": "мария", "password": "паролата-на-мария"}).status_code == 200
    assert maria.get("/api/batches").status_code == 200
    assert maria.get("/api/auth/users").status_code == 403
    assert maria.put("/api/stores/premierparfums/access", json={"token": "x"}).status_code == 403
    # Disabled: logged out at once.
    c.patch(f"/api/auth/users/{created.json()['id']}", json={"disabled": True})
    assert maria.get("/api/batches").status_code == 401
    with Session(engine()) as session:
        stored = session.scalar(select(User.password_hash).where(User.name == "Мария"))
    assert stored.startswith("scrypt$") and "паролата" not in stored


def test_too_many_wrong_passwords_wait(real_login):
    c = real_login
    c.post("/api/auth/setup", json={"name": "admin", "password": "дълга-парола-1"})
    other = TestClient(app)
    codes = [
        other.post("/api/auth/login", json={"name": "admin", "password": "не-е-тя-0000"}).status_code for _ in range(6)
    ]
    assert codes[:5] == [401] * 5 and codes[5] == 429


def test_shopify_access_is_encrypted_and_never_returned(real_login, monkeypatch):
    from pipeline import shopify
    from pipeline.config import load_group

    c = real_login
    c.post("/api/auth/setup", json={"name": "admin", "password": "дълга-парола-1"})
    r = c.put("/api/stores/premierparfums/access", json={"client_id": "cid-123", "client_secret": "shpss_secret"})
    assert r.status_code == 200 and r.json()["kind"] == "client" and r.json()["updated_by"] == "admin"
    assert "shpss_secret" not in r.text
    listing = c.get("/api/stores").text
    assert "shpss_secret" not in listing and "cid-123" not in listing
    with Session(engine()) as session:
        row = session.get(StoreSecret, "premierparfums")
    assert row.client_secret and "shpss_secret" not in row.client_secret  # encrypted at rest
    store = load_group("group-1").store("premierparfums")
    monkeypatch.setattr(store, "shop", "premier.myshopify.com")
    for name in (
        "SHOPIFY_TOKEN_PREMIERPARFUMS",
        "SHOPIFY_CLIENT_ID_PREMIERPARFUMS",
        "SHOPIFY_CLIENT_SECRET_PREMIERPARFUMS",
    ):
        monkeypatch.delenv(name, raising=False)
    assert shopify.missing_settings(store) is None  # the app's access is enough
    assert shopify._access(store) == (None, "cid-123", "shpss_secret")
    assert c.delete("/api/stores/premierparfums/access").status_code == 200
    assert "Няма достъп" in shopify.missing_settings(store)
