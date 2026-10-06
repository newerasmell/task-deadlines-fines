import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
FIXTURES = ROOT / "tests" / "fixtures"


def png(width: int, height: int) -> bytes:
    """A packshot: a dark 'bottle' (40% wide, 80% high) centred on white."""
    from io import BytesIO

    from PIL import Image, ImageDraw

    im = Image.new("RGB", (width, height), "white")
    ImageDraw.Draw(im).rectangle(
        (int(width * 0.3), int(height * 0.1), int(width * 0.7) - 1, int(height * 0.9) - 1), fill=(40, 30, 20)
    )
    buf = BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture(autouse=True)
def no_image_downloads(monkeypatch):
    """Tests never touch the network: every image URL 'downloads' as a 1200×1200 PNG unless a test says otherwise."""
    picture = png(1200, 1200)
    monkeypatch.setattr("pipeline.images.fetch", lambda url: picture)


@pytest.fixture(autouse=True)
def no_batch_waiting(monkeypatch):
    """The Batches API is polled every few seconds; the fake client finishes at once, so never wait."""
    monkeypatch.setattr("pipeline.ai.time.sleep", lambda seconds: None)


@pytest.fixture(autouse=True)
def media_in_tmp(tmp_path, monkeypatch):
    """Stored pictures go to a temporary MEDIA_DIR, never output/media."""
    from pipeline.settings import get_settings

    monkeypatch.setattr(get_settings(), "media_dir", tmp_path / "media")
    return tmp_path / "media"


TEST_USER = {"id": 0, "name": "test", "is_admin": True, "disabled": False}


@pytest.fixture(autouse=True)
def logged_in():
    """API tests act as a logged-in admin; tests/test_auth.py removes this to test the login itself. The actor
    of a decision still comes from the X-Actor header there (no session user is set)."""
    from api.auth import require_admin, require_user
    from api.main import app

    async def user():
        return TEST_USER

    app.dependency_overrides[require_user] = user
    app.dependency_overrides[require_admin] = user
    yield
    app.dependency_overrides.clear()
