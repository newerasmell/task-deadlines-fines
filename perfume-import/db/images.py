"""A person replaces a product's picture (a link or an uploaded file): it becomes the product's new original
and is composed again for every store by its layout (size, background, bottle position), like research
pictures are. The image field of every store then points at its finished picture."""

import ipaddress
import socket
from io import BytesIO
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.orm import Session

from db.models import Batch, Event, FieldRow, Media, Product, StoreProduct
from pipeline import images, media
from pipeline.compose import compose_for_stores
from pipeline.config import load_group

MAX_UPLOAD = 25_000_000


class ImageError(Exception):
    """Bulgarian message for the person."""


def _engine():
    from db.repo import engine

    return engine()


def _public_url(url: str) -> str:
    """Only http(s) to a public address: the server fetches it, so never an internal one."""
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ImageError("Въведи линк, който започва с https://")
    try:
        infos = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise ImageError(f"Адресът {parsed.hostname} не съществува.") from exc
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise ImageError("Този адрес не е публичен.")
    return url.strip()


def from_url(url: str) -> bytes:
    url = _public_url(url)
    try:
        return images.fetch(url)
    except images.FetchError as exc:
        raise ImageError(f"Снимката не се свали: {exc}.") from exc


def replace(product_id: int, data: bytes, source: str, actor: str | None) -> dict:
    """New original from these bytes, composed for every store of the product; returns the product."""
    from PIL import Image, UnidentifiedImageError

    from db.repo import media_url
    from db.review import _product_json, _withdraw_approval, now

    if len(data) > MAX_UPLOAD:
        raise ImageError("Файлът е по-голям от 25 MB.")
    try:
        with Image.open(BytesIO(data)) as im:
            width, height = im.size
    except (UnidentifiedImageError, OSError) as exc:
        raise ImageError("Това не е снимка (JPG, PNG или WEBP).") from exc

    with Session(_engine()) as session, session.begin():
        product = session.get(Product, product_id)
        if product is None:
            raise KeyError(f"Няма продукт {product_id}.")
        batch = session.get(Batch, product.batch_id)
        group = load_group(batch.group_key)
        sps = session.execute(select(StoreProduct).where(StoreProduct.product_id == product_id)).scalars().all()
        try:
            composed = compose_for_stores(data, group, [sp.store_key for sp in sps])
            compose_error = None
        except Exception as exc:  # no layout yet, or a picture the cut-out cannot handle: keep the original
            composed, compose_error = {}, f"{type(exc).__name__}: {exc}"

        def add(blob: bytes, kind: str, layout: str | None, info: dict) -> Media:
            stored = media.write(blob)
            row = Media(
                product_id=product_id,
                kind=kind,
                layout=layout,
                source_url=source if source.startswith("http") else None,
                path=stored.path,
                content_type=stored.content_type,
                width=stored.width,
                height=stored.height,
                bytes=stored.bytes,
                sha256=stored.sha256,
                info=info,
            )
            session.add(row)
            session.flush()
            return row

        original = add(data, "original", None, {"source": source, "replaced_by": actor})
        by_layout: dict[str, Media] = {}
        min_height = group.spec.rules.image_min_height
        when = now()
        for sp in sps:
            c = composed.get(sp.store_key)
            if c is not None and c.layout not in by_layout:
                info = {"bottle": list(c.bottle), "scaled": c.scaled, "warnings": c.warnings}
                by_layout[c.layout] = add(c.data, "composed", c.layout, info)
            finished = by_layout.get(c.layout) if c is not None else None
            row = session.execute(
                select(FieldRow).where(FieldRow.store_product_id == sp.id, FieldRow.key == "image")
            ).scalar_one_or_none()
            if row is None:
                continue
            warnings = list(c.warnings) if c is not None else []
            if height < min_height:
                warnings.append(f"Снимката е {width}×{height} px, под минимума {min_height} px.")
            if compose_error:
                warnings.append(f"Не е сглобена ({compose_error}); остава оригиналът.")
            message = f"Сменена от {actor or 'екипа'}: {width}×{height} px от {source}." + (
                f" Сглобена върху фона на магазина: {c.width}×{c.height} px." if finished is not None else ""
            )
            row.previous = row.value
            row.value = media_url((finished or original).id)
            row.alternatives = [media_url(original.id)] if finished is not None else []
            row.sources = [
                {
                    "url": source if source.startswith("http") else None,
                    "title": source,
                    "width": width,
                    "height": height,
                }
            ]
            row.origin = "input"
            row.status = "warning" if warnings else "ok"
            row.message = " ".join([message, *warnings])
            row.issues = [{"status": "warning", "rule": "image_replaced", "message": w} for w in warnings]
            row.decided_by, row.decided_at = actor, when
        _withdraw_approval(session, product_id)
        session.add(
            Event(
                actor=actor,
                kind="image_replaced",
                batch_id=batch.id,
                payload={"product": product_id, "source": source, "width": width, "height": height},
            )
        )
        session.flush()
        return _product_json(session, product_id)
