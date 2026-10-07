"""Stores and their profiles in the app (SPEC §2, §8.7).

A catalog export uploaded in the app becomes a proposed profile (detect_store), versioned per store with a diff
against the accepted one, plus a group recommendation. Accepting it records the store in its group and audits
the same export. Store settings made here (a new store, its Shopify domain) are kept in stores.settings and
merged over stores.yaml by pipeline.config.load_group; secrets never: only the names of their env vars.
"""

import copy
import hashlib
import re
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from db.models import Batch, Store, StoreProfile, StoreSecret
from pipeline import config, media, shopify
from pipeline.config import list_groups, load_group
from pipeline.detect import detect_profile
from pipeline.export import load_export
from pipeline.groups import rank
from pipeline.secrets import decrypt, encrypt
from pipeline.shopify import client_credential_names, missing_settings
from pipeline.text import slugify


class StoreError(Exception):
    """Something the person can fix; Bulgarian message."""


def _engine():
    from db.repo import engine

    return engine()


# ---- settings merged into the config ---------------------------------------------------------------------


def _overrides(group_key: str) -> dict[str, dict]:
    with Session(_engine()) as session:
        rows = session.execute(select(Store).where(Store.group_key == group_key)).scalars().all()
        return {s.key: dict(s.settings) for s in rows if s.settings}


def _stored_access(store_key: str) -> dict | None:
    with Session(_engine()) as session:
        row = session.get(StoreSecret, store_key)
        if row is None:
            return None
        return {
            k: decrypt(v) if v else None
            for k, v in (("client_id", row.client_id), ("client_secret", row.client_secret), ("token", row.token))
        }


def install() -> None:
    """Make load_group see the stores and domains set in the app, and Shopify the access entered in it."""
    config.store_overrides = _overrides
    shopify.stored_access = _stored_access


# ---- Shopify access entered in the app --------------------------------------------------------------------


def set_access(store_key: str, client_id: str, client_secret: str, token: str, actor: str | None) -> dict:
    """A Dev Dashboard app's Client ID + secret, or an older custom app's Admin API token. Stored encrypted;
    the values are never returned, only that they are set, when and by whom."""
    client_id, client_secret, token = client_id.strip(), client_secret.strip(), token.strip()
    if not token and not (client_id and client_secret):
        raise StoreError("Въведи Client ID и Client secret (или Admin API токен).")
    if store_key not in {k for g in list_groups() for k in load_group(g).stores}:
        raise KeyError(f"Няма магазин „{store_key}“.")
    with Session(_engine()) as session, session.begin():
        row = session.get(StoreSecret, store_key) or StoreSecret(store_key=store_key)
        row.client_id = encrypt(client_id) if client_id else None
        row.client_secret = encrypt(client_secret) if client_secret else None
        row.token = encrypt(token) if token else None
        row.updated_by, row.updated_at = actor, datetime.now(UTC)
        session.add(row)
    shopify.forget_token(store_key)
    return access_info(store_key)


def clear_access(store_key: str) -> None:
    with Session(_engine()) as session, session.begin():
        row = session.get(StoreSecret, store_key)
        if row:
            session.delete(row)
    shopify.forget_token(store_key)


def access_info(store_key: str) -> dict | None:
    """Whether access is set in the app (never the values)."""
    with Session(_engine()) as session:
        row = session.get(StoreSecret, store_key)
        if row is None:
            return None
        return {
            "kind": "token" if row.token else "client",
            "updated_by": row.updated_by,
            "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        }


def check_access(store_key: str) -> dict:
    """One read-only call to the store: its name, so the person sees the keys work."""
    known = {k: g for g in list_groups() for k in load_group(g).stores}
    if store_key not in known:
        raise KeyError(f"Няма магазин „{store_key}“.")
    group = load_group(known[store_key])
    try:
        shop = shopify.store_client(group, store_key)
        data = shop.graphql("{ shop { name myshopifyDomain } }")["shop"]
    except shopify.ShopifyError as exc:
        return {"ok": False, "message": str(exc)}
    return {"ok": True, "message": f"Връзката работи: {data['name']} ({data['myshopifyDomain']})."}


# ---- list ------------------------------------------------------------------------------------------------


def _store_key(name: str) -> str:
    base = re.sub(r"\s*\(.*\)\s*", "", name).strip() or name
    return slugify(base).replace("-", "")[:40]


def list_stores() -> list[dict]:
    groups = {key: load_group(key) for key in list_groups()}
    with Session(_engine()) as session:
        profiles = session.execute(
            select(StoreProfile).order_by(StoreProfile.store_key, StoreProfile.version)
        ).scalars()
        latest: dict[str, StoreProfile] = {}
        accepted: dict[str, StoreProfile] = {}
        for p in profiles:
            latest[p.store_key] = p
            if p.state == "accepted":
                accepted[p.store_key] = p
        db_stores = {s.key: s for s in session.execute(select(Store)).scalars()}
        audits = dict(
            session.execute(
                select(Batch.store_key, func.max(Batch.id)).where(Batch.kind == "audit").group_by(Batch.store_key)
            ).all()
        )

    out, seen = [], set()
    for group in groups.values():
        for key, store in group.stores.items():
            seen.add(key)
            out.append(_store_row(key, group.key, store, latest.get(key), accepted.get(key), audits.get(key)))
    for key, row in db_stores.items():  # stores added in the app and not yet in a group
        if key not in seen and row.settings:
            out.append(_store_row(key, None, None, latest.get(key), accepted.get(key), audits.get(key), row))
    return out


def _store_row(key, group_key, store, latest, accepted, audit_batch, row: Store | None = None) -> dict:
    settings = (row.settings if row else {}) or {}
    profile = accepted or latest
    if accepted:
        state = "active"
    elif latest and latest.state == "proposed":
        state = "proposed"
    else:
        state = "waiting"
    return {
        "key": key,
        "label": store.label if store else settings.get("label", key),
        "group": group_key,
        "country": store.country if store else settings.get("country"),
        "language": store.language if store else settings.get("language"),
        "currency": store.currency if store else settings.get("currency"),
        "shop": (store.shop if store and store.shop != "CHANGE_ME" else None) or settings.get("shop"),
        "access": missing_settings(store) if store else None,
        "access_set": access_info(key),
        "profile_accepted": accepted is not None,
        "state": state,
        "products": profile.profile.get("products") if profile else None,
        "catalog_at": profile.created_at.isoformat() if profile else None,
        "profile_id": latest.id if latest else None,
        "audit_batch_id": audit_batch,
    }


# ---- analyze ---------------------------------------------------------------------------------------------


def _save_export(data: bytes, filename: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(filename).name) or "export.csv"
    if Path(safe).suffix.lower() not in (".csv", ".xlsx", ".xlsm"):
        raise StoreError("Файлът трябва да е .csv или .xlsx (експорт от Shopify: Products → Export).")
    relative = f"exports/{hashlib.sha256(data).hexdigest()[:16]}-{safe}"
    path = media.root() / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def _reference(session: Session, group_key: str | None, store_key: str):
    """The newest accepted export of another store in the group: same products, so note pairs can be learned."""
    if not group_key:
        return None
    group = load_group(group_key)
    rows = session.execute(
        select(StoreProfile)
        .where(StoreProfile.state == "accepted", StoreProfile.store_key.in_(list(group.stores)))
        .where(StoreProfile.store_key != store_key)
        .order_by(StoreProfile.id.desc())
    ).scalars()
    for row in rows:
        path = row.profile.get("export_path")
        if path and media.resolve(path).is_file():
            return load_export(media.resolve(path))
    return None


def analyze(
    data: bytes,
    filename: str,
    *,
    name: str,
    shop: str | None = None,
    country: str | None = None,
    language: str | None = None,
    currency: str | None = None,
    group_key: str | None = None,
    store_key: str | None = None,
    actor: str | None = None,
) -> int:
    """Detect a profile from an uploaded export; returns the proposed profile's id."""
    if not name.strip() and not store_key:
        raise StoreError("Въведи име на магазина.")
    path = _save_export(data, filename)
    try:
        export = load_export(path)
    except Exception as exc:
        raise StoreError(f"Файлът не се чете като експорт от Shopify: {type(exc).__name__}.") from exc
    if "Handle" not in export.columns or not export.products:
        raise StoreError("Във файла няма колона Handle или няма продукти. Експортирай всички продукти от Shopify.")

    key = store_key or _store_key(name)
    known = {k: g for g in list_groups() for k in load_group(g).stores}
    if not store_key and key in known:
        raise StoreError(f"Магазин „{key}“ вече има (група {known[key]}). Ползвай „Обнови каталога“ от списъка.")
    group_key = group_key or known.get(key)
    group = load_group(group_key) if group_key else None

    with Session(_engine()) as session, session.begin():
        reference = _reference(session, group_key, key)
        profile = detect_profile(export, key, group=group, reference=reference)
        profile["source"] = Path(filename).name
        profile["export_path"] = str(path.relative_to(media.root()))
        profile["group_scores"] = rank(profile, [load_group(g) for g in list_groups()])

        # Only what the person typed is stored now; language, country and currency come from the profile when it
        # is accepted, after the person has checked them (a catalog can be mostly in the wrong language).
        typed = {
            "label": name.strip(),
            "shop": (shop or "").strip(),
            "country": country,
            "language": language,
            "currency": currency,
        }
        row = session.get(Store, key)
        if row is None:
            row = Store(key=key, label=typed["label"] or key, group_key=group_key)
            session.add(row)
        settings = dict(row.settings or {})
        settings.update({k: v for k, v in typed.items() if v})
        if key not in known:  # a new store: everything comes from here
            settings.setdefault("token_env", f"SHOPIFY_TOKEN_{key.upper()}")
        row.settings = settings
        if settings.get("label"):
            row.label = settings["label"]

        previous = session.execute(
            select(StoreProfile)
            .where(StoreProfile.store_key == key, StoreProfile.state == "accepted")
            .order_by(StoreProfile.version.desc())
            .limit(1)
        ).scalar_one_or_none()
        version = (
            session.execute(select(func.max(StoreProfile.version)).where(StoreProfile.store_key == key)).scalar() or 0
        ) + 1
        session.flush()
        record = StoreProfile(
            store_key=key,
            version=version,
            state="proposed",
            profile=profile,
            diff=diff(previous.profile if previous else None, profile),
            source_filename=Path(filename).name,
            decided_by=None,
        )
        session.add(record)
        session.flush()
        return record.id


def diff(old: dict | None, new: dict) -> dict:
    """Which items changed since the accepted profile (values only)."""
    if not old:
        return {"first": True, "changed": []}
    changed = []
    for key, item in new.get("items", {}).items():
        before = (old.get("items", {}).get(key) or {}).get("value") if isinstance(item, dict) else None
        after = item.get("value") if isinstance(item, dict) else None
        if isinstance(item, dict) and before != after:
            changed.append({"key": key, "before": before, "after": after})
    return {"first": False, "changed": changed}


# ---- read / decide ---------------------------------------------------------------------------------------


def get_profile(profile_id: int) -> dict:
    with Session(_engine()) as session:
        row = session.get(StoreProfile, profile_id)
        if row is None:
            raise KeyError(f"Няма профил {profile_id}.")
        store = session.get(Store, row.store_key)
        settings = dict(store.settings or {}) if store else {}
        group_key = store.group_key if store else None
        config_store = None
        if group_key:
            config_store = load_group(group_key).stores.get(row.store_key)
        id_name, secret_name = (
            client_credential_names(config_store)
            if config_store
            else (f"SHOPIFY_CLIENT_ID_{row.store_key.upper()}", f"SHOPIFY_CLIENT_SECRET_{row.store_key.upper()}")
        )
        audit = (
            session.execute(
                select(Batch.id)
                .where(Batch.kind == "audit", Batch.store_key == row.store_key)
                .order_by(Batch.id.desc())
            )
            .scalars()
            .first()
        )
        return {
            "id": row.id,
            "store": row.store_key,
            "label": (config_store.label if config_store else None) or settings.get("label") or row.store_key,
            "group": group_key,
            "shop": (config_store.shop if config_store and config_store.shop != "CHANGE_ME" else None)
            or settings.get("shop"),
            "access_env": {
                "client_id": id_name,
                "client_secret": secret_name,
                "token": settings.get("token_env") or (config_store.token_env if config_store else None),
            },
            "access_set": access_info(row.store_key),
            "access": missing_settings(config_store) if config_store else None,
            "version": row.version,
            "state": row.state,
            "created_at": row.created_at.isoformat(),
            "decided_by": row.decided_by,
            "source": row.source_filename,
            "diff": row.diff,
            "profile": row.profile,
            "audit_batch_id": audit,
        }


def update_item(profile_id: int, key: str, value, actor: str | None) -> dict:
    """A person's correction of one profile item; it counts as confirmed."""
    with Session(_engine()) as session, session.begin():
        row = session.get(StoreProfile, profile_id)
        if row is None:
            raise KeyError(f"Няма профил {profile_id}.")
        if row.state != "proposed":
            raise StoreError("Решен профил не се променя; качи каталога отново за нова версия.")
        profile = copy.deepcopy(row.profile)
        item = profile["items"].get(key)
        if not isinstance(item, dict) or "value" not in item:
            raise StoreError(f"Свойството „{key}“ не се променя оттук.")
        if key == "currency":
            code = str(value or "").strip().upper()
            if not re.fullmatch(r"[A-Z]{3}", code):
                raise StoreError("Въведи само код на валутата, напр. EUR. Пазарите (Cyprus…) се четат от експорта.")
            value = code
        item.update({"previous": item.get("value"), "value": value, "status": "accepted", "edited_by": actor})
        profile["to_confirm"] = [k for k in profile.get("to_confirm", []) if k != key]
        row.profile = profile
    return get_profile(profile_id)


def accept(profile_id: int, group_key: str | None, actor: str | None) -> dict:
    """Confirm every shown item, record the store in its group, audit the same export (SPEC §8.7)."""
    from db.repo import save_audit
    from pipeline.validate import audit

    if not group_key:
        raise StoreError(
            "Магазинът не прилича на никоя група. Създай нова група от този експорт с /new-group в Claude Code "
            "и после избери нея."
        )
    group = load_group(group_key)
    if group.spec is None:
        raise StoreError(f"Група „{group_key}“ още няма group.yaml; създай го с /new-group от експорт на нейн магазин.")
    with Session(_engine()) as session, session.begin():
        row = session.get(StoreProfile, profile_id)
        if row is None:
            raise KeyError(f"Няма профил {profile_id}.")
        if row.state != "proposed":
            raise StoreError("Профилът вече е решен.")
        profile = copy.deepcopy(row.profile)
        for item in profile["items"].values():
            if isinstance(item, dict) and item.get("status") == "suggested":
                item["status"] = "accepted"
        profile["to_confirm"] = []
        profile["group"] = group_key
        row.profile = profile
        row.state, row.decided_by, row.decided_at = "accepted", actor, datetime.now(UTC)
        store = session.get(Store, row.store_key)
        store.group_key = group_key
        items = profile["items"]
        markets = (items.get("markets") or {}).get("value") or []
        from_profile = {
            "language": (items.get("content_language") or {}).get("value"),
            "currency": (items.get("currency") or {}).get("value"),
            "country": markets[0].get("country") if markets else None,
        }
        settings = dict(store.settings or {})
        in_yaml = row.store_key in group.stores
        for k, v in from_profile.items():
            if v and not settings.get(k) and not in_yaml:
                settings[k] = v
        missing = [k for k in ("country", "language", "currency") if not settings.get(k) and not in_yaml]
        if missing:
            raise StoreError(f"Липсва {', '.join(missing)} за магазина; попълни го в профила и запази отново.")
        store.settings = settings
        export_path = media.resolve(profile["export_path"])
        store_key = row.store_key
    report = audit(load_export(export_path), load_group(group_key), store_key)
    report.source = profile.get("source", report.source)
    batch_id = save_audit(report, author=actor)
    return {**get_profile(profile_id), "audit_batch_id": batch_id}


def reject(profile_id: int, actor: str | None) -> dict:
    with Session(_engine()) as session, session.begin():
        row = session.get(StoreProfile, profile_id)
        if row is None:
            raise KeyError(f"Няма профил {profile_id}.")
        if row.state != "proposed":
            raise StoreError("Профилът вече е решен.")
        row.state, row.decided_by, row.decided_at = "rejected", actor, datetime.now(UTC)
    return get_profile(profile_id)


def set_shop(store_key: str, shop: str, actor: str | None) -> None:
    """The store's Shopify domain (not a secret), set in the app instead of stores.yaml."""
    shop = shop.strip().lower().removeprefix("https://").rstrip("/")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*\.myshopify\.com", shop):
        raise StoreError("Адресът трябва да е във вида име.myshopify.com.")
    with Session(_engine()) as session, session.begin():
        row = session.get(Store, store_key)
        if row is None:
            known = {k: g for g in list_groups() for k in load_group(g).stores}
            if store_key not in known:
                raise KeyError(f"Няма магазин „{store_key}“.")
            cfg = load_group(known[store_key]).stores[store_key]
            row = Store(key=store_key, label=cfg.label, group_key=known[store_key])
            session.add(row)
        row.settings = {**(row.settings or {}), "shop": shop}
        row.shop_domain = shop


def accepted_profiles(store_keys: list[str]) -> dict[str, dict]:
    """The newest accepted profile per store: new products are built by it (CLAUDE.md principle 1)."""
    with Session(_engine()) as session:
        rows = session.execute(
            select(StoreProfile)
            .where(StoreProfile.store_key.in_(store_keys), StoreProfile.state == "accepted")
            .order_by(StoreProfile.version)
        ).scalars()
        return {r.store_key: r.profile for r in rows}
