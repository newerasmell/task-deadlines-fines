"""Database schema (docs/SPEC.md §3). Store profiles live here too (SPEC §2), versioned per store."""

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

ORIGINS = ("input", "template", "vocab", "ai_research", "ai_generated", "auto_fix")
STATUSES = ("ok", "suggested", "fixed", "warning", "blocked")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} in ({', '.join(repr(v) for v in values)})"


class Base(DeclarativeBase):
    pass


class Created:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Store(Created, Base):
    __tablename__ = "stores"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    group_key: Mapped[str | None] = mapped_column(String(64))
    label: Mapped[str]
    country: Mapped[str | None] = mapped_column(String(2))
    language: Mapped[str | None] = mapped_column(String(8))
    currency: Mapped[str | None] = mapped_column(String(3))
    shop_domain: Mapped[str | None]
    # Name of the env var holding the Admin API token, never the token itself.
    token_env: Mapped[str | None]


class StoreProfile(Created, Base):
    __tablename__ = "store_profiles"
    __table_args__ = (
        UniqueConstraint("store_key", "version"),
        CheckConstraint(_in("state", ("proposed", "accepted", "rejected")), name="state_valid"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    store_key: Mapped[str] = mapped_column(ForeignKey("stores.key", ondelete="CASCADE"))
    version: Mapped[int]
    state: Mapped[str] = mapped_column(String(16), default="proposed")
    profile: Mapped[dict] = mapped_column(JSONB)
    diff: Mapped[dict | None] = mapped_column(JSONB)
    source_filename: Mapped[str | None]
    decided_by: Mapped[str | None]
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Batch(Created, Base):
    __tablename__ = "batches"
    __table_args__ = (CheckConstraint(_in("kind", ("new", "audit")), name="kind_valid"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), default="new")
    name: Mapped[str]
    group_key: Mapped[str] = mapped_column(String(64))
    store_key: Mapped[str | None] = mapped_column(ForeignKey("stores.key"))  # audit batches: one store
    publish_status: Mapped[str] = mapped_column(String(16), default="draft")
    author: Mapped[str | None]


class Product(Created, Base):
    """Canonical, language-neutral product: the input row plus research reused by all stores."""

    __tablename__ = "products"
    id: Mapped[int] = mapped_column(primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("batches.id", ondelete="CASCADE"), index=True)
    ean: Mapped[str | None] = mapped_column(String(14), index=True)
    input: Mapped[dict] = mapped_column(JSONB)
    research: Mapped[dict | None] = mapped_column(JSONB)


class StoreProduct(Created, Base):
    __tablename__ = "store_products"
    __table_args__ = (UniqueConstraint("product_id", "store_key"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))
    store_key: Mapped[str] = mapped_column(ForeignKey("stores.key"))
    shopify_product_id: Mapped[str | None]
    uploaded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class FieldRow(Base):
    """One field of one store product, always with provenance (SPEC §3)."""

    __tablename__ = "fields"
    __table_args__ = (
        UniqueConstraint("store_product_id", "key"),
        CheckConstraint(_in("origin", ORIGINS), name="origin_valid"),
        CheckConstraint(_in("status", STATUSES), name="status_valid"),
        CheckConstraint("confidence is null or (confidence >= 0 and confidence <= 1)", name="confidence_range"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    store_product_id: Mapped[int] = mapped_column(ForeignKey("store_products.id", ondelete="CASCADE"))
    key: Mapped[str] = mapped_column(String(64))
    value: Mapped[object | None] = mapped_column(JSONB)
    origin: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), index=True)
    confidence: Mapped[float | None] = mapped_column(Float)
    sources: Mapped[list] = mapped_column(JSONB, default=list)
    alternatives: Mapped[list] = mapped_column(JSONB, default=list)
    previous: Mapped[object | None] = mapped_column(JSONB)
    value_en: Mapped[str | None] = mapped_column(Text)
    message: Mapped[str | None] = mapped_column(Text)
    # Every rule that fired on this field ({status, rule, message}); `message` is the worst one.
    issues: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")
    decided_by: Mapped[str | None]
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Event(Base):
    """Audit log: every decision, edit, fix and upload."""

    __tablename__ = "events"
    id: Mapped[int] = mapped_column(primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    actor: Mapped[str | None]
    kind: Mapped[str] = mapped_column(String(32))
    batch_id: Mapped[int | None] = mapped_column(ForeignKey("batches.id", ondelete="SET NULL"))
    store_product_id: Mapped[int | None] = mapped_column(ForeignKey("store_products.id", ondelete="SET NULL"))
    field_key: Mapped[str | None] = mapped_column(String(64))
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)


class VocabLearned(Created, Base):
    __tablename__ = "vocab_learned"
    __table_args__ = (
        UniqueConstraint("group_key", "field_key", "variant"),
        CheckConstraint(_in("status", ("suggested", "accepted", "rejected")), name="vocab_status_valid"),
    )
    id: Mapped[int] = mapped_column(primary_key=True)
    group_key: Mapped[str] = mapped_column(String(64))
    field_key: Mapped[str] = mapped_column(String(64))
    variant: Mapped[str]
    canonical: Mapped[str]
    source: Mapped[str | None]
    hits: Mapped[int] = mapped_column(Integer, default=1)
    # AI proposals start as suggested; a person accepts them once in the app (docs/decisions.md #5).
    status: Mapped[str] = mapped_column(String(16), default="suggested", server_default="suggested")
    confidence: Mapped[float | None] = mapped_column(Float)
    reason: Mapped[str | None] = mapped_column(Text)


class Media(Created, Base):
    """A picture on disk (pipeline/media.py): the downloaded original of a product or a finished composition.

    A composition is per layout, not per store: stores that share a layout share the file."""

    __tablename__ = "media"
    __table_args__ = (CheckConstraint(_in("kind", ("original", "composed")), name="media_kind_valid"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    layout: Mapped[str | None] = mapped_column(String(64))  # "group" or a store key with its own layout
    source_url: Mapped[str | None] = mapped_column(Text)
    path: Mapped[str] = mapped_column(Text)  # relative to MEDIA_DIR
    content_type: Mapped[str] = mapped_column(String(32))
    width: Mapped[int]
    height: Mapped[int]
    bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    info: Mapped[dict] = mapped_column(JSONB, default=dict)  # compose details: scale, bottle size, warnings
