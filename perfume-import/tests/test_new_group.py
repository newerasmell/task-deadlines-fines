"""/new-group: a group's structure from its stores' exports (here: the GR export, compared with group-1)."""

import subprocess
import sys

import yaml

from pipeline.build import ProductInput, build_store_fields
from pipeline.config import load_group
from pipeline.settings import ROOT
from tests.conftest import FIXTURES


def test_new_group_from_exports(tmp_path):
    (tmp_path / "groups").mkdir()
    run = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "new_group.py"),
            "--group",
            "group-x",
            "--name",
            "Група X",
            "--config",
            str(tmp_path),
            f"grx={FIXTURES / 'premierparfums_export.csv'}",
            f"hrx={FIXTURES / 'parfemija_export.csv'}",
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    assert run.returncode == 0, run.stderr + run.stdout
    assert "Групата group-x е създадена" in run.stdout

    group = load_group("group-x", base=tmp_path)
    reference = load_group("group-1")
    assert group.spec.title == reference.spec.title and group.spec.sku == reference.spec.sku
    assert set(group.spec.metafields) == set(reference.spec.metafields)  # sklad is left out (decisions #8)
    assert group.template_columns[:3] == ["Handle", "Title", "Body (HTML)"]
    assert "Women's Perfume" in group.vocab["gender"]
    assert group.spec.tester_sentence["el"].startswith("Η έκδοση TESTER")
    assert set(group.stores) == {"grx", "hrx"} and group.stores["grx"].currency == "EUR"
    assert yaml.safe_load((tmp_path / "groups" / "group-x" / "group.yaml").read_text())["name"] == "Група X"

    fields = build_store_fields(
        ProductInput("Dior", "Sauvage", "Eau de Toilette", 100, False, "3348901250153", {"grx": "89.00"}), group, "grx"
    )
    assert fields["title"].value == "Dior Sauvage EDT 100 ml" and fields["sku"].value == "SK3348901250153"

    again = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "new_group.py"),
            "--group",
            "group-x",
            "--name",
            "X",
            "--config",
            str(tmp_path),
            f"grx={FIXTURES / 'premierparfums_export.csv'}",
        ],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    assert again.returncode == 2 and "--force" in again.stdout  # never overwritten by accident
