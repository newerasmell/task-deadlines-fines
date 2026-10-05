"""One real product through the real API. Opt-in: pytest -m live (needs ANTHROPIC_API_KEY, ~$0.40)."""

import os

import pytest

from pipeline.ai import default_client
from pipeline.batch import run_batch
from pipeline.config import load_group
from pipeline.input import read_input
from pipeline.settings import ROOT

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(not os.environ.get("ANTHROPIC_API_KEY"), reason="ANTHROPIC_API_KEY is not set"),
]


def test_one_real_product():
    group = load_group("group-1")
    stores = ["premierparfums", "parfemija"]
    rows = read_input(ROOT / "input" / "sample-5.csv", group, stores)[:1]
    result = run_batch(default_client(), rows, group, stores, "live")
    p = result.products[0]
    assert p.research.error is None
    assert p.research.fields["brand"].value
    assert p.stores["premierparfums"]["body_html"].value.startswith("<p>")
    print(result.summary())
