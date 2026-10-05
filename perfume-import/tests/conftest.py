import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
FIXTURES = ROOT / "tests" / "fixtures"


def png(width: int, height: int) -> bytes:
    from io import BytesIO

    from PIL import Image

    buf = BytesIO()
    Image.new("RGB", (width, height), "white").save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture(autouse=True)
def no_image_downloads(monkeypatch):
    """Tests never touch the network: every image URL 'downloads' as a 1200×1200 PNG unless a test says otherwise."""
    picture = png(1200, 1200)
    monkeypatch.setattr("pipeline.images.fetch", lambda url: picture)
