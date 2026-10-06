from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    database_url: str = "postgresql+psycopg://perfume:perfume@localhost:5432/perfume"
    config_dir: Path = ROOT / "config"
    app_dist: Path = ROOT / "app" / "dist"
    # Finished and original pictures (SPEC §6). On Render: the persistent disk at /var/data/media.
    media_dir: Path = ROOT / "output" / "media"

    @property
    def sqlalchemy_url(self) -> str:
        # Render hands out postgres:// URLs; SQLAlchemy needs the psycopg driver named explicitly.
        url = self.database_url
        for prefix in ("postgres://", "postgresql://"):
            if url.startswith(prefix):
                return "postgresql+psycopg://" + url[len(prefix) :]
        return url


@lru_cache
def get_settings() -> Settings:
    return Settings()
