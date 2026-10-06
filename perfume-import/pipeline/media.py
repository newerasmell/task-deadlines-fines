"""Pictures on disk (SPEC §6): the downloaded original and each finished composition, under MEDIA_DIR.

Files are named by their content (<sha256[:2]>/<sha256>.<ext>): the same picture is stored once, however many
products or batches use it, and a file is never overwritten with something else. Paths are relative to
MEDIA_DIR, so the files can move (local output/media, Render disk /var/data/media) without touching the database.
"""

import hashlib
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

from PIL import Image

from pipeline.settings import get_settings

CONTENT_TYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}


@dataclass
class Stored:
    path: str  # relative to MEDIA_DIR
    content_type: str
    width: int
    height: int
    bytes: int
    sha256: str


def root() -> Path:
    return get_settings().media_dir


def extension(data: bytes) -> str:
    with Image.open(BytesIO(data)) as im:
        fmt = (im.format or "PNG").lower()
    return {"jpeg": "jpg", "mpo": "jpg"}.get(fmt, fmt)


def write(data: bytes) -> Stored:
    sha = hashlib.sha256(data).hexdigest()
    ext = extension(data)
    path = f"{sha[:2]}/{sha}.{ext}"
    target = root() / path
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(f".{ext}.tmp")
        tmp.write_bytes(data)
        tmp.replace(target)  # never a half-written file under the real name
    with Image.open(BytesIO(data)) as im:
        width, height = im.size
    return Stored(
        path=path,
        content_type=CONTENT_TYPES.get(ext, f"image/{ext}"),
        width=width,
        height=height,
        bytes=len(data),
        sha256=sha,
    )


def resolve(path: str) -> Path:
    """Absolute path of a stored file; refuses anything outside MEDIA_DIR."""
    base = root().resolve()
    target = (base / path).resolve()
    if not target.is_relative_to(base):
        raise ValueError("Пътят излиза извън MEDIA_DIR.")
    return target
