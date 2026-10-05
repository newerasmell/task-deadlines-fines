"""detect_store must reproduce the seed in config/groups/group-1 from the two real exports (SPEC §9.1).

Items where the exports and the seed disagree (description shape, compare-at range, HR content language,
local-language vocab without an English link) are reported by scripts/phase1_report.py, not asserted here.
"""

from collections import Counter

import pytest

from pipeline.config import load_group
from pipeline.detect import detect_profile
from pipeline.export import load_export
from pipeline.seed_check import compare
from pipeline.titles import parse_title, render
from pipeline.vocab import LearnedVocab, VocabMatcher
from tests.conftest import FIXTURES

STORES = {"premierparfums": "parfemija", "parfemija": "premierparfums"}
MUST_AGREE = (
    "title",
    "handle",
    "sku",
    "ean_location",
    "concentration_short",
    "title_language",
    "currency",
    "metafield_set",
    "metafields_used",
    "fixed: ",
    "google.",
    "price.rounding",
)


@pytest.fixture(scope="module")
def group():
    return load_group("group-1")


@pytest.fixture(scope="module", params=list(STORES))
def checks(request, group):
    store, reference = request.param, STORES[request.param]
    profile = detect_profile(
        load_export(FIXTURES / f"{store}_export.csv"),
        store,
        group=group,
        reference=load_export(FIXTURES / f"{reference}_export.csv"),
    )
    return compare(profile, group)


def test_structure_matches_seed(checks):
    failed = [c for c in checks if c.item.startswith(MUST_AGREE) and not c.agrees]
    assert not failed, "\n".join(f"{c.item}: config={c.config!r} detected={c.detected!r}" for c in failed)


def test_seed_vocab_canonicals_are_found(checks):
    failed = [
        c for c in checks if c.item.startswith("vocab.") and c.config == c.item.split(": ", 1)[-1] and not c.agrees
    ]
    assert not failed, [(c.item, c.detected, c.note) for c in failed]


def test_seed_spelling_variants_map_to_their_canonical(checks):
    spelling = [c for c in checks if c.item.startswith("vocab.") and c.note in ("вариант", "съпоставен различно")]
    assert spelling, "no seed variants found in the export"
    failed = [c for c in spelling if not c.agrees]
    assert not failed, [(c.item, c.config, c.detected) for c in failed]


def test_profile_items_carry_rate_examples_and_status(group):
    profile = detect_profile(load_export(FIXTURES / "premierparfums_export.csv"), "premierparfums", group=group)
    items = dict(profile["items"])
    nested = {**items.pop("fixed_columns"), **{f"vocab.{k}": v for k, v in items.pop("vocab").items()}}
    for key, value in {**items, **nested}.items():
        assert {"value", "match_rate", "status", "examples"} <= set(value), key
        if value["match_rate"] is not None and value["match_rate"] < 0.9:
            assert value["status"] == "suggested", key


# ---- unit tests on the building blocks ---------------------------------------------------------------


def test_title_parse_and_render_roundtrip():
    formula = "{brand} {name} {concentration_short} {ml} ml{tester: ' TESTER'}"
    p = parse_title("Paco Rabanne Lady Million Fabulous EDP 80 ml TESTER", "Paco Rabanne")
    assert (p.brand, p.name, p.concentration, p.ml, p.tester) == (
        "Paco Rabanne",
        "Lady Million Fabulous",
        "EDP",
        "80",
        "TESTER",
    )
    values = {
        "brand": p.brand,
        "name": p.name,
        "concentration_short": p.concentration,
        "ml": p.ml,
        "tester": True,
    }
    assert render(formula, values) == p.title
    assert render(formula, {**values, "tester": False}) == "Paco Rabanne Lady Million Fabulous EDP 80 ml"


def test_learned_vocab_groups_spellings_but_keeps_men_and_women_apart():
    values = Counter(
        {
            "Women's Perfume": 30,
            "Women’s perfume": 5,
            "Men's Perfume": 20,
            "Unisex Perfume": 10,
            "Unsiex": 1,
            "Unisex": 2,
        }
    )
    v = LearnedVocab(values)
    assert {c.canonical for c in v.canonical} == {"Women's Perfume", "Men's Perfume", "Unisex Perfume"}
    assert v.lookup("Unsiex").canonical == "Unisex Perfume"
    assert v.lookup("Men's perfume").canonical == "Men's Perfume"


def test_learned_vocab_prefers_the_spelling_used_in_compounds():
    values = Counter(
        {
            "Wood": 50,
            "Woody": 5,
            "Woody Spicy": 4,
            "Amber Woody": 4,
            "Woody Floral": 3,
            "Fruit": 9,
            "Fruity": 2,
            "Oriental Fruity": 3,
            "Fruity Floral": 3,
        }
    )
    v = LearnedVocab(values)
    assert not v.stopwords  # "Wood" dominates on its own; that does not make it a qualifier
    assert v.lookup("Wood").canonical == "Woody"
    assert v.lookup("Fruit").canonical == "Fruity"


def test_learned_vocab_marks_other_script_as_translation():
    v = LearnedVocab(Counter({"Floral": 40, "Woody": 20, "Ανθινος": 8}))
    assert v.lookup("Ανθινος").local
    assert "Ανθινος" not in {c.canonical for c in v.canonical}


def test_vocab_matcher():
    m = VocabMatcher(load_group("group-1").vocab["fragrance_family"])
    assert m.match("Floral") == ("Floral", "exact")
    assert m.match("Wood") == ("Woody", "variant")
    assert m.match("Fruity-Floral") == ("Floral Fruity", "normalized")
    assert m.match("Oriental Florall")[0] == "Oriental Floral"
    assert m.match("Woody Spicy") == (None, "none")
    g = VocabMatcher(load_group("group-1").vocab["gender"])
    assert g.match("Men’s perfume") == ("Men's Perfume", "variant")
    assert g.match("Women's Perfumes")[0] == "Women's Perfume"
