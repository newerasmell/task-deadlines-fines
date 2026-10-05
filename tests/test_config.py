import csv

from pipeline import ean
from pipeline.config import input_template_columns, list_groups, load_group
from pipeline.settings import ROOT
from pipeline.text import levenshtein, slugify, space_ml


def test_group_1_loads():
    group = load_group("group-1")
    assert group.spec is not None
    assert group.spec.sku == "SK{ean}"
    assert group.spec.description.length == (200, 450)
    assert group.spec.rules.compare_at_ratio == (1.3, 2.0)
    assert len(group.stores) == 10
    assert group.store("parfemija").language == "hr"
    assert group.store("parfemija").price.rounding == "00"  # inherited from defaults
    assert set(group.vocab) == {"gender", "fragrance_family"}
    assert "Variant SKU" in group.template_columns


def test_group_2_loads_without_structure():
    group = load_group("group-2")
    assert group.spec is None
    assert len(group.stores) == 8


def test_every_group_loads():
    for key in list_groups():
        load_group(key)


def test_input_template_matches_stores_yaml():
    with (ROOT / "input" / "products_template.csv").open(encoding="utf-8") as fh:
        header = next(csv.reader(fh))
    assert header == input_template_columns(load_group("group-1"))


def test_ean_checksum():
    assert ean.is_valid("3614273776127")  # EAN-13 from the GR export
    assert ean.is_valid("692753569783")  # UPC-A (12 digits)
    assert ean.is_valid("96385074")  # EAN-8
    assert not ean.is_valid("3614273776128")
    assert not ean.is_valid("361427377612")
    assert ean.clean("'5901234123457") == "5901234123457"
    assert ean.problem("") == "Липсва EAN."
    assert "контролна цифра" in ean.problem("3614273776128")


def test_text_helpers():
    assert slugify("Louis Vuitton L'immensite EDP 100 ml TESTER") == "louis-vuitton-limmensite-edp-100-ml-tester"
    assert (
        slugify("Jo Malone Nectarine Blossom & Honey EDC 100 ml") == "jo-malone-nectarine-blossom-and-honey-edc-100-ml"
    )
    assert slugify("Lancôme Idôle EDP 50 ml") == "lancome-idole-edp-50-ml"
    assert space_ml("Xerjoff Opera EDP 100ml TESTER") == "Xerjoff Opera EDP 100 ml TESTER"
    assert levenshtein("unsiex", "unisex") == 1
    assert levenshtein("wood", "woody") == 1
