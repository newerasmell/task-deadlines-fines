"""Groups made in the app (group 3 and on) and a group's structure learned from its connected stores
(docs/decisions.md #49). Both live on the persistent disk (pipeline.config.app_groups_dir)."""

import re

import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from db.models import StoreProfile
from pipeline import media
from pipeline.config import app_groups_dir, list_groups, load_group
from pipeline.export import load_export
from pipeline.newgroup import write_group

MAX_EXPORTS = 3  # the structure is learned from the largest three stores, as /new-group does


class GroupError(Exception):
    """Bulgarian message."""


def _engine():
    from db.repo import engine

    return engine()


def name_of(key: str) -> str:
    meta = app_groups_dir() / key / "meta.yaml"
    if meta.exists():
        return (yaml.safe_load(meta.read_text("utf-8")) or {}).get("name") or key
    m = re.fullmatch(r"group-(\d+)", key)
    return f"Група {m[1]}" if m else key


def create(name: str) -> str:
    """A new empty group, the next number (group-3, group-4…); its stores are then connected into it."""
    numbers = [int(m[1]) for g in list_groups() if (m := re.fullmatch(r"group-(\d+)", g))]
    key = f"group-{max(numbers, default=0) + 1}"
    folder = app_groups_dir() / key
    folder.mkdir(parents=True, exist_ok=False)
    (folder / "meta.yaml").write_text(yaml.safe_dump({"name": name.strip() or name_of(key)}, allow_unicode=True))
    return key


def derive(group_key: str) -> dict:
    """The group's structure from its connected stores' products (their learned templates keep the export)."""
    group = load_group(group_key)
    with Session(_engine()) as session:
        rows = session.execute(
            select(StoreProfile)
            .where(StoreProfile.store_key.in_(list(group.stores)), StoreProfile.state != "rejected")
            .order_by(StoreProfile.version.desc())
        ).scalars()
        latest: dict[str, StoreProfile] = {}
        for row in rows:
            latest.setdefault(row.store_key, row)
    sources = sorted(
        ((k, p) for k, p in latest.items() if p.profile.get("export_path")),
        key=lambda kp: -(kp[1].profile.get("products") or 0),
    )[:MAX_EXPORTS]
    if not sources:
        raise GroupError("Първо свържи поне един магазин от групата: структурата се научава от продуктите му.")
    exports = {k: load_export(media.resolve(p.profile["export_path"])) for k, p in sources}
    summary = write_group(app_groups_dir() / group_key, name_of(group_key), exports)
    return {"group": group_key, "stores": [k for k, _ in sources], **summary}
