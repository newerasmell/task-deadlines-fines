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
    "πατσουλί στη βάση. Ιδανικό για βραδινές εξόδους και ξεχωριστές στιγμές, για όσους αγαπούν τα ζεστά, "
    "αισθησιακά και κομψά αρώματα με λουλουδένιο χαρακτήρα.</p>"
)
EL_TESTER = "Η έκδοση TESTER περιέχει την ίδια αρωματική σύνθεση και προορίζεται κυρίως για πρακτική χρήση."


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
    assert run(ctx, fragrance_family="Spicy Woody")["fragrance_family"].value == "Woody Spicy"


def test_value_outside_vocab_is_a_warning_with_alternatives(ctx):
    p = run(ctx, fragrance_family="Floral Lavender")
    assert p["fragrance_family"].status == "warning"
    assert "Woody" in p["fragrance_family"].alternatives


def test_spacing_and_ml_are_auto_fixed(ctx):
    p = run(ctx, title="Tom Ford  Orchid Soleil EDP 100ml ", product_milliliters="100ml")
    assert p["title"].value == "Tom Ford Orchid Soleil EDP 100 ml"
    assert p["title"].status == "fixed"
    assert p["product_milliliters"].value == "100 ml"


def test_ean_is_read_from_the_sku(ctx):
    p = run(ctx, ean="")
    assert (p["ean"].value, p["ean"].status) == ("692753569783", "ok")


@pytest.mark.parametrize(
    ("sku", "field", "rule"),
    [
        ("SK1000000034912N", "ean", "ean_invalid"),  # letter after the EAN
        ("SK692753569784", "ean", "ean_invalid"),  # wrong check digit
        ("SK73348901116817", "ean", "ean_invalid"),  # extra leading digit
        ("XX692753569783", "sku", "sku_formula"),  # does not follow SK{ean}
        ("NAN", "sku", "sku_missing"),
        ("", "sku", "sku_missing"),
    ],
)
def test_bad_sku_or_ean_is_blocked(ctx, sku, field, rule):
    p = run(ctx, ean="", sku=sku)
    assert (p[field].status, p[field].rule) == ("blocked", rule)


def test_sku_must_match_given_ean(ctx):
    p = run(ctx, sku="SK3614273776127")
    assert (p["sku"].status, p["sku"].alternatives) == ("blocked", ["SK692753569783"])


@pytest.mark.parametrize(
    ("price", "compare", "rule"),
    [("99", "99", "compare_at_not_above"), ("99", "258", "compare_at_ratio")],
)
def test_price_rules_block(ctx, price, compare, rule):
    p = run(ctx, price=price, compare_at=compare)
    blocked = [f.rule for f in p.values() if f.status == "blocked"]
    assert blocked == [rule]


def test_missing_price_is_a_warning_not_a_block(ctx):
    """decisions #16: prices can be set in Shopify; the product only goes up as a draft."""
    p = run(ctx, price="", compare_at="149")
    assert (p["price"].status, p["price"].rule) == ("warning", "price_missing")
    assert not [f for f in p.values() if f.status == "blocked"]


def test_missing_compare_at_is_fine(ctx):
    assert run(ctx, compare_at="")["compare_at"].status == "ok"


def test_compare_at_range_is_1_2_to_2_5(ctx):
    assert run(ctx, compare_at="237.60")["compare_at"].status == "ok"  # 2.4x
    assert run(ctx, compare_at="118.80")["compare_at"].status == "ok"  # 1.2x


def test_empty_paragraph_is_removed(ctx):
    p = run(ctx, body_html=GREEK_BODY + "<p></p>")
    assert (p["body_html"].value, p["body_html"].status) == (GREEK_BODY, "fixed")


def test_language_and_description_rules(ctx):
    english = (
        "<p>" + "A warm floral fragrance with pink pepper, bitter orange and tuberose for evening wear. " * 3 + "</p>"
    )
    p = run(ctx, body_html=english, top_note="pink pepper, bitter orange")
    assert "language_body" in [i["rule"] for i in p["body_html"].issues]
    assert p["top_note"].rule == "language_notes"
    assert run(ctx, body_html="<p>Σύντομο.</p>")["body_html"].rule == "description_length"


def test_tester_needs_the_fixed_sentence_of_the_store_language(ctx):
    title = "Tom Ford Orchid Soleil EDP 100 ml TESTER"
    p = run(ctx, title=title)
    assert (p["body_html"].rule, p["body_html"].alternatives) == ("tester_sentence", [EL_TESTER])
    almost = GREEK_BODY.replace("</p>", " Η έκδοση TESTER περιέχει την ίδια αρωματική σύνθεση.</p>")
    assert run(ctx, title=title, body_html=almost)["body_html"].rule == "tester_sentence"
    exact = GREEK_BODY.replace("</p>", f" {EL_TESTER}</p>")
    assert run(ctx, title=title, body_html=exact)["body_html"].status == "ok"


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


def test_translated_notes_are_not_mistaken_for_english():
    """Live: Croatian „jantar, kumarin, vetiver“ was flagged as English. With the English reference next to it,
    only an untranslated copy is flagged."""
    hr = Context(load_group("group-1"), load_group("group-1").store("parfemija"))
    p = product(base_note="jantar, kumarin, vetiver")
    p["base_note"].value_en = "amber, coumarin, vetiver"
    validate_product(p, hr)
    assert "language_notes" not in [i["rule"] for i in p["base_note"].issues]
    q = product(base_note="amber, tonka bean, vanilla")
    q["base_note"].value_en = "amber, tonka bean, vanilla"
    validate_product(q, hr)
    assert q["base_note"].rule == "language_notes"
