"""Encryption for secrets kept in the database (Shopify access set in the app).

The key is PERFUME_SECRET_KEY when set, else a key generated once into MEDIA_DIR/.secret-key (on Render the
persistent disk, not the database): a copy of the database alone does not reveal any secret.
"""

import os
from functools import cache

from cryptography.fernet import Fernet, InvalidToken

from pipeline.settings import get_settings


@cache
def _fernet() -> Fernet:
    key = os.environ.get("PERFUME_SECRET_KEY", "").strip()
    if not key:
        path = get_settings().media_dir / ".secret-key"
        if path.is_file():
            key = path.read_text().strip()
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            key = Fernet.generate_key().decode()
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(key)
    return Fernet(key.encode())


def encrypt(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt(value: str) -> str | None:
    """None when the key changed (the secret has to be entered again)."""
    try:
        return _fernet().decrypt(value.encode()).decode()
    except InvalidToken:
        return None
