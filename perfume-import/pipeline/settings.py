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
    # Background removal model: u2netp (4.7 MB) fits the 512 MB server; u2net (176 MB, a bit finer edges) needs
    # about 400 MB more memory.
    rembg_model: str = "u2netp"
    # Cutting a bottle out of a scene with the model needs ~500-800 MB: off on the 512 MB plan (such pictures are
    # placed whole on the store's background; flat backgrounds are still cut out). REMBG_ENABLED=1 on 2 GB.
    rembg_enabled: bool = False
    # Every store's products are read from Shopify this often (hours); 0 turns it off.
    sync_hours: float = 6

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
