"""The deterministic builder reproduces title, handle and SKU of real products from their parts."""

import pytest

from pipeline import ean
from pipeline.build import ProductInput, build_store_fields, formulas
from pipeline.config import load_group
from pipeline.export import load_export
from pipeline.text import collapse_spaces, slugify
from pipeline.titles import parse_title
from tests.conftest import FIXTURES


@pytest.fixture(scope="module")
def group():
    return load_group("group-1")


def product(**kw) -> ProductInput:
    base = dict(
        brand="Tom Ford",
        name="Orchid Soleil",
        concentration="Eau de Parfum",
        ml=100,
        tester=False,
        ean="692753569783",
        prices={"parfemija": "99.00"},
    )
    return ProductInput(**{**base, **kw})


def test_builds_every_deterministic_field(group):
    f = build_store_fields(product(), group, "parfemija")
    assert f["title"].value == "Tom Ford Orchid Soleil EDP 100 ml"
    assert f["handle"].value == "tom-ford-orchid-soleil-edp-100-ml"
    assert f["sku"].value == "SK692753569783"
    assert f["custom.product_milliliters"].value == "100 ml"
    assert f["custom.product_type"].value == "EDP"
    assert "custom.sklad" not in f  # legacy field, no longer written (docs/decisions.md #8)
    assert f["seo_title"].value == f["title"].value
    assert f["fixed.Variant Grams"].value == 300
    assert f["google.product_category"].value == 479
    assert f["price"].value == "99.00"
    assert all(x.origin in ("template", "input") and x.status == "ok" for x in f.values())


def test_tester_and_full_concentrations(group):
    f = build_store_fields(product(concentration="Parfum", ml="90", tester=True, name="Libre Le"), group, "parfemija")
    assert f["title"].value == "Tom Ford Libre Le Parfum 90 ml TESTER"
    assert f["handle"].value == "tom-ford-libre-le-parfum-90-ml-tester"
    assert f["custom.product_type"].value == "Parfum"  # Parfum, Extrait, Elixir stay full


def test_unknown_store_is_a_clear_error(group):
    with pytest.raises(KeyError, match="не е в"):
        build_store_fields(product(), group, "nosuchstore")


def test_confirmed_profile_formula_wins_over_group(group):
    profile = {"items": {"sku_pattern": {"value": "PP-{ean}", "status": "ok"}}}
    assert formulas(group, profile)["sku"] == "PP-{ean}"
    suggested = {"items": {"sku_pattern": {"value": "PP-{ean}", "status": "suggested"}}}
    assert formulas(group, suggested)["sku"] == "SK{ean}"


@pytest.mark.parametrize("store", ["premierparfums", "parfemija"])
def test_reproduces_real_products(group, store):
    """Every export product whose title follows the formula is rebuilt exactly from its parts.

    SKUs are rebuilt for the large majority; the rest are typos in the export (SK…N, an extra leading digit,
    NAN), which validate.py reports."""
    following, titles, skus = 0, 0, 0
    for p in load_export(FIXTURES / f"{store}_export.csv").products:
        parsed = parse_title(p["Title"], p["Vendor"])
        code = ean.clean(p["Sklad (product.metafields.custom.sklad)"])
        if not (parsed.brand and parsed.concentration and parsed.ml and parsed.ml_spaced and ean.is_valid(code)):
            continue
        if parsed.tester not in (None, "TESTER"):
            continue
        following += 1
        item = ProductInput(
            brand=parsed.brand,
            name=parsed.name,
            concentration=parsed.concentration,
            ml=parsed.ml,
            tester=parsed.tester is not None,
            ean=code,
            prices={},
        )
        f = build_store_fields(item, group, store)
        same_handle = p["Handle"] != slugify(p["Title"]) or f["handle"].value == p["Handle"]
        # Double spaces in a few source titles are a defect validate.py fixes; compare without them.
        titles += f["title"].value == collapse_spaces(p["Title"]) and same_handle
        skus += f["sku"].value == p["Variant SKU"]
    assert following > 400
    assert titles == following
    assert skus / following >= 0.93, f"{skus}/{following}"
