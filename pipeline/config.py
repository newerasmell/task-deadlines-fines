"""Load group and store configuration from config/ (SPEC §2b)."""

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field

from pipeline.settings import get_settings


class DescriptionSpec(BaseModel):
    guide: str = "description.md"
    length: tuple[int, int] = (200, 450)
    html: str = "single <p>"


class RulesSpec(BaseModel):
    compare_at_ratio: tuple[float, float] = (1.3, 2.0)
    image_min_height: int = 1000


class GroupSpec(BaseModel):
    """group.yaml. Unknown keys are kept so new formulas don't need a code change to load."""

    model_config = ConfigDict(extra="allow")

    name: str
    title: str
    handle: str = "slug(title)"
    sku: str
    title_language: str = "en"
    concentration_short: dict[str, str] = Field(default_factory=dict)
    auto_accept_generated: bool = False
    metafields: dict[str, Any] = Field(default_factory=dict)
    google: dict[str, Any] = Field(default_factory=dict)
    fixed: dict[str, Any] = Field(default_factory=dict)
    seo: dict[str, Any] = Field(default_factory=dict)
    description: DescriptionSpec = Field(default_factory=DescriptionSpec)
    rules: RulesSpec = Field(default_factory=RulesSpec)


class PriceRules(BaseModel):
    rounding: str | None = None


class StoreConfig(BaseModel):
    key: str
    label: str
    country: str
    language: str
    currency: str
    shop: str | None = None
    token_env: str | None = None
    status: str = "draft"
    price: PriceRules = Field(default_factory=PriceRules)


@dataclass
class Group:
    key: str
    path: Path
    spec: GroupSpec | None  # None until a group has its structure defined (group-2 today)
    stores: dict[str, StoreConfig]
    vocab: dict[str, dict[str, list[str]]]
    description_guide: str
    template_columns: list[str]

    def store(self, key: str) -> StoreConfig:
        if key not in self.stores:
            raise KeyError(f"Магазин „{key}“ не е в {self.path / 'stores.yaml'}. Налични: {', '.join(self.stores)}")
        return self.stores[key]


def config_dir() -> Path:
    return get_settings().config_dir


def _yaml(path: Path) -> Any:
    return yaml.safe_load(path.read_text(encoding="utf-8")) if path.exists() else None


def load_group(key: str, base: Path | None = None) -> Group:
    path = (base or config_dir()) / "groups" / key
    if not path.is_dir():
        raise FileNotFoundError(f"Няма група „{key}“ в {path.parent}")

    raw_group = _yaml(path / "group.yaml")
    spec = GroupSpec.model_validate(raw_group) if raw_group else None

    raw_stores = _yaml(path / "stores.yaml") or {}
    defaults = raw_stores.get("defaults") or {}
    stores = {}
    for store_key, values in (raw_stores.get("stores") or {}).items():
        stores[store_key] = StoreConfig.model_validate({**defaults, **values, "key": store_key})

    vocab = {f: {c: list(v or []) for c, v in (m or {}).items()} for f, m in (_yaml(path / "vocab.yaml") or {}).items()}
    guide_path = path / (spec.description.guide if spec else "description.md")
    template_path = path / "import_template.csv"
    template_columns: list[str] = []
    if template_path.exists():
        with template_path.open(encoding="utf-8-sig", newline="") as fh:
            template_columns = next(csv.reader(fh), [])

    return Group(
        key=key,
        path=path,
        spec=spec,
        stores=stores,
        vocab=vocab,
        description_guide=guide_path.read_text(encoding="utf-8") if guide_path.exists() else "",
        template_columns=template_columns,
    )


def list_groups(base: Path | None = None) -> list[str]:
    root = (base or config_dir()) / "groups"
    return sorted(p.name for p in root.iterdir() if p.is_dir())


def load_glossary(language: str, base: Path | None = None) -> dict[str, str]:
    """English canonical note -> local term, lowercase. Empty until the language is seeded."""
    data = _yaml((base or config_dir()) / "glossary" / f"{language}.yaml") or {}
    return {str(k).lower(): str(v).lower() for k, v in data.items()}


INPUT_BASE_COLUMNS = ["name", "ml", "tester", "ean"]


def input_template_columns(group: Group) -> list[str]:
    """input/products_template.csv: one price column per store, in stores.yaml order."""
    return [*INPUT_BASE_COLUMNS, *(f"price_{k}" for k in group.stores), "notes"]
