"""Deterministic fields, built by code from the group formulas (CLAUDE.md principle 3). Never by the AI.

A store's confirmed profile wins over the group defaults (principle 1): pass the profile items whose
status is ok (or accepted) as `profile` and their formulas replace the group's.
"""

from dataclasses import dataclass

from pipeline.config import Group
from pipeline.fields import Field
from pipeline.text import format_ml, slugify
from pipeline.titles import render, short_concentration

# group.yaml metafields whose formula is a plain string are deterministic; dict entries come from vocab,
# research or generated text and are filled in later phases.
NAMESPACE = "custom"


@dataclass
class ProductInput:
    """One normalized input row (SPEC §1). Brand/name/concentration come from normalization in phase 2."""

    brand: str
    name: str
    concentration: str | None
    ml: float | int | str
    tester: bool
    ean: str
    prices: dict[str, str | None]


def formulas(group: Group, profile: dict | None = None) -> dict:
    spec = group.spec
    out = {
        "title": spec.title,
        "handle": spec.handle,
        "sku": spec.sku,
        "concentration_short": spec.concentration_short,
    }
    if profile:
        items = profile.get("items", profile)
        for key, item_key in (("title", "title_pattern"), ("handle", "handle"), ("sku", "sku_pattern")):
            item = items.get(item_key)
            if item and item.get("status") in ("ok", "accepted") and item.get("value"):
                out[key] = item["value"]
        conc = items.get("concentration_short")
        if conc and conc.get("status") in ("ok", "accepted"):
            out["concentration_short"] = conc["value"]
    return out


def build_store_fields(
    product: ProductInput, group: Group, store_key: str, profile: dict | None = None
) -> dict[str, Field]:
    spec = group.spec
    if spec is None:
        raise ValueError(
            f"Група „{group.key}“ още няма group.yaml; качи каталог на магазин от нея (SPEC §2)."
        )
    group.store(store_key)  # unknown store -> clear error
    f = formulas(group, profile)

    def template(key: str, value) -> Field:
        return Field(key=key, value=value, origin="template", status="ok")

    values = {
        "brand": product.brand,
        "name": product.name,
        "concentration_short": short_concentration(product.concentration, f["concentration_short"]),
        "ml": format_ml(product.ml),
        "tester": product.tester,
        "ean": product.ean,
    }
    title = render(f["title"], values)
    values["title"] = title
    fields: dict[str, Field] = {
        "title": template("title", title),
        "handle": template(
            "handle", slugify(title) if f["handle"] == "slug(title)" else render(f["handle"], values)
        ),
        "sku": template("sku", render(f["sku"], values)),
        "vendor": Field(key="vendor", value=product.brand, origin="input", status="ok"),
        "ean": Field(key="ean", value=product.ean, origin="input", status="ok"),
    }
    if seo_title := spec.seo.get("title"):
        fields["seo_title"] = template("seo_title", render(seo_title, values))

    for key, formula in spec.metafields.items():
        if isinstance(formula, str):
            fields[f"{NAMESPACE}.{key}"] = template(f"{NAMESPACE}.{key}", render(formula, values))

    for column, value in spec.fixed.items():
        fields[f"fixed.{column}"] = template(f"fixed.{column}", value)
    if "product_category" in spec.google:
        fields["google.product_category"] = template(
            "google.product_category", spec.google["product_category"]
        )
    if "condition" in spec.google:
        fields["google.condition"] = template("google.condition", spec.google["condition"])

    price = product.prices.get(store_key)
    fields["price"] = Field(key="price", value=price or None, origin="input", status="ok")
    return fields


def google_gender(gender: str | None, group: Group) -> str | None:
    """Google Shopping gender from the canonical gender, per group.yaml google.gender."""
    return (group.spec.google.get("gender") or {}).get(gender or "")
