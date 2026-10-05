"""validate.py: each SPEC §7 rule on a small product, plus the audit on both real exports."""

import pytest

from pipeline.config import load_group
from pipeline.export import load_export
from pipeline.fields import Field
from pipeline.validate import Context, audit, validate_batch, validate_product
from tests.conftest import FIXTURES

GREEK_BODY = (
    "<p>Το Tom Ford Orchid Soleil EDP 100 ml είναι ένα ανατολίτικο λουλουδάτο άρωμα με νότες από ροζ πιπέρι, "
    "πικρό πορτοκάλι και κυπαρίσσι στην κορυφή, τουμπερόζα και κόκκινο κρίνο στην καρδιά, και βανίλια με "
    "πατσουλί στη βάση. Ιδανικό για βραδινές εξόδους και ξεχωριστές στιγμές.</p>"
)


@pytest.fixture(scope="module")
def ctx():
    return Context(load_group("group-1"), load_group("group-1").store("premierparfums"))


def product(**overrides) -> dict[str, Field]:
    values = {
        "title": "Tom Ford Orchid Soleil EDP 100 ml",
        "handle": "tom-ford-orchid-soleil-edp-100-ml",
        "sku": "SK692753569783",
        "ean": "692753569783",
        "vendor": "Tom Ford",
        "body_html": GREEK_BODY,
        "price": "99.00",
        "compare_at": "149.00",
        "image": "https://cdn.example/x.png",
        "gender": "Women's Perfume",
        "fragrance_family": "Oriental Floral",
        "top_note": "ροζ πιπέρι, πικρό πορτοκάλι",
        "product_milliliters": "100 ml",
    }
    values.update(overrides)
    return {k: Field(key=k, value=v, origin="input", status="ok") for k, v in values.items()}


def run(ctx, **overrides) -> dict[str, Field]:
    p = product(**overrides)
    validate_product(p, ctx)
    return p


def test_clean_product_is_ok(ctx):
    p = run(ctx)
    assert {k: f.status for k, f in p.items() if f.status != "ok"} == {}


def test_vocab_variants_are_auto_fixed(ctx):
    p = run(ctx, gender="Unsiex", fragrance_family="Wood")
    assert (p["gender"].value, p["gender"].status, p["gender"].previous) == ("Unisex Perfume", "fixed", "Unsiex")
    assert (p["fragrance_family"].value, p["fragrance_family"].origin) == ("Woody", "auto_fix")
    p = run(ctx, gender="Men’s Perfume ")
    assert p["gender"].value == "Men's Perfume"


def test_value_outside_vocab_is_a_warning_with_alternatives(ctx):
    p = run(ctx, fragrance_family="Woody Spicy")
    assert p["fragrance_family"].status == "warning"
    assert "Woody" in p["fragrance_family"].alternatives


def test_spacing_and_ml_are_auto_fixed(ctx):
    p = run(ctx, title="Tom Ford  Orchid Soleil EDP 100ml ", product_milliliters="100ml")
    assert p["title"].value == "Tom Ford Orchid Soleil EDP 100 ml"
    assert p["title"].status == "fixed"
    assert p["product_milliliters"].value == "100 ml"


@pytest.mark.parametrize(
    ("ean_value", "rule"),
    [("", "ean_missing"), ("692753569784", "ean_invalid"), ("ABC123", "ean_invalid")],
)
def test_bad_ean_is_blocked(ctx, ean_value, rule):
    p = run(ctx, ean=ean_value, sku="SK1")
    assert p["ean"].status == "blocked"
    assert p["ean"].rule == rule


def test_ean_found_in_sku_is_offered_but_still_blocked(ctx):
    p = run(ctx, ean="")
    assert p["ean"].status == "blocked"
    assert p["ean"].alternatives == ["692753569783"]


def test_sku_rules(ctx):
    assert run(ctx, sku="NAN")["sku"].status == "blocked"
    p = run(ctx, sku="SK692753569783N")
    assert (p["sku"].status, p["sku"].alternatives) == ("warning", ["SK692753569783"])


@pytest.mark.parametrize(
    ("price", "compare", "rule"),
    [("", "149", "price_missing"), ("99", "99", "compare_at_not_above"), ("99", "250", "compare_at_ratio")],
)
def test_price_rules_block(ctx, price, compare, rule):
    p = run(ctx, price=price, compare_at=compare)
    blocked = [f.rule for f in p.values() if f.status == "blocked"]
    assert blocked == [rule]


def test_missing_compare_at_is_fine(ctx):
    assert run(ctx, compare_at="")["compare_at"].status == "ok"


def test_language_and_description_rules(ctx):
    english = (
        "<p>" + "A warm floral fragrance with pink pepper, bitter orange and tuberose for evening wear. " * 3 + "</p>"
    )
    p = run(ctx, body_html=english, top_note="pink pepper, bitter orange")
    assert "language_body" in [i["rule"] for i in p["body_html"].issues]
    assert p["top_note"].rule == "language_notes"
    assert run(ctx, body_html="<p>Σύντομο.</p>")["body_html"].rule == "description_length"


def test_tester_needs_tester_sentence(ctx):
    p = run(ctx, title="Tom Ford Orchid Soleil EDP 100 ml TESTER")
    assert p["body_html"].rule == "tester_sentence"
    body = GREEK_BODY.replace("</p>", " Η έκδοση TESTER περιέχει την ίδια αρωματική σύνθεση.</p>")
    p = run(ctx, title="Tom Ford Orchid Soleil EDP 100 ml TESTER", body_html=body)
    assert p["body_html"].status == "ok"


def test_missing_image_is_blocked(ctx):
    assert run(ctx, image="")["image"].status == "blocked"


def test_duplicates_in_batch_and_in_store_are_blocked():
    a, b, c = product(), product(), product(sku="SK5", handle="other")
    validate_batch([a, b, c], existing_skus={"SK5"})
    assert a["sku"].rule == b["sku"].rule == "sku_duplicate"
    assert a["handle"].status == "blocked"
    assert c["sku"].rule == "sku_exists"


@pytest.mark.parametrize("store", ["premierparfums", "parfemija"])
def test_audit_on_real_export_finds_known_defects(store):
    report = audit(load_export(FIXTURES / f"{store}_export.csv"), load_group("group-1"), store)
    s = report.summary()
    assert s["products"] == len(report.products) > 800
    by_title = {p.title: p for p in report.products}
    junk = by_title["Mystery Tester"]  # a placeholder row in both exports
    assert junk.status == "blocked"
    assert junk.fields["title"].rule in ("title_no_ml", "tester_marker")
    assert "title_no_ml" in [i["rule"] for i in junk.fields["title"].issues]
    assert any(p.fields["sku"].rule == "sku_duplicate" for p in report.products)
    assert s["rules"]["gender_variant"]["count"] > 100
    assert s["rules"]["format"]["count"] > 40  # "100ml" titles
    fixed_unsiex = [p for p in report.products if p.fields["gender"].previous == "Unsiex"]
    assert all(p.fields["gender"].value == "Unisex Perfume" for p in fixed_unsiex)
    for row in report.findings():
        assert row["message"], row
