"""Economy vs deep research, chosen per batch, per selected EANs, or per product row."""

import csv

import pytest
from sqlalchemy import delete
from sqlalchemy.orm import Session

from pipeline.batch import good_enough, resolve_tier, run_batch
from pipeline.config import input_template_columns, load_group
from pipeline.input import read_input
from pipeline.research import research_product
from pipeline.settings import ROOT
from pipeline.tiers import TIERS, tier
from tests.fake_ai import FakeClient, message
from tests.test_batch import STORES, responder
from tests.test_research import ROW, A, B, C, research_answer

GROUP = load_group("group-1")


def write_input(tmp_path, research_values):
    path = tmp_path / "in.csv"
    sample = list(csv.DictReader((ROOT / "input" / "sample-5.csv").open(encoding="utf-8")))
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=input_template_columns(GROUP))
        w.writeheader()
        for row, value in zip(sample, research_values, strict=False):
            w.writerow({**{k: row.get(k, "") for k in input_template_columns(GROUP)}, "research": value})
    return path


def test_tier_names_and_aliases():
    assert tier(None).name == tier("").name == "economy"
    assert tier("Задълбочено").name == tier("deep").name == "deep"
    with pytest.raises(KeyError, match="Непознат режим"):
        tier("premium")


def test_research_column_is_read_per_row(tmp_path):
    rows = read_input(write_input(tmp_path, ["deep", "", "евтино", "premium"]), GROUP, STORES)
    assert [r.tier for r in rows[:4]] == ["deep", None, "economy", None]
    assert "premium" in rows[3].problems[0]


def test_most_specific_choice_wins(tmp_path):
    rows = read_input(write_input(tmp_path, ["economy", "", ""]), GROUP, STORES)
    deep = {rows[0].ean, rows[1].ean}
    assert resolve_tier(rows[0], "economy", deep).name == "economy"  # the row's own column beats --deep
    assert resolve_tier(rows[1], "economy", deep).name == "deep"  # --deep beats the batch tier
    assert resolve_tier(rows[2], "deep").name == "deep"  # batch tier


def test_deep_research_reads_pages_with_opus():
    client = FakeClient(message(research_answer(), urls=[A, B, C]))
    research_product(client, ROW, GROUP, TIERS["deep"])
    call = client.calls[0]
    assert call["model"] == "claude-opus-5-5" and call["output_config"]["effort"] == "high"
    tools = {t["name"]: t for t in call["tools"]}
    assert tools["web_search"]["max_uses"] == 6
    assert tools["web_fetch"]["max_uses"] == 4 and tools["web_fetch"]["max_content_tokens"] == 6000
    assert "web fetch" in call["system"]


def test_economy_research_is_search_only_with_sonnet():
    client = FakeClient(message(research_answer(), urls=[A, B, C]))
    research_product(client, ROW, GROUP, TIERS["economy"])
    call = client.calls[0]
    assert call["model"] == "claude-sonnet-5-5" and [t["name"] for t in call["tools"]] == ["web_search"]
    assert "cannot open pages" in call["system"]


def test_mixed_batch_sends_economy_texts_to_batches_and_deep_ones_right_away(monkeypatch):
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    rows = read_input(ROOT / "input" / "sample-5.csv", GROUP, STORES)[:2]
    client = FakeClient(responder=responder)
    result = run_batch(client, rows, GROUP, STORES, "test", deep_eans={rows[1].ean})
    assert client.batches == [["m0"], ["t0-el", "t0-hr"]]  # only the economy product
    deep_text_calls = [c for c in client.calls if not c.get("tools") and c["model"] == "claude-opus-5-5"]
    assert len(deep_text_calls) == 3 and all("thinking" not in c for c in deep_text_calls)
    assert [p.tier.name for p in result.products] == ["economy", "deep"]
    assert result.summary()["tiers"] == {"economy": 1, "deep": 1}


def test_budget_is_checked_against_each_products_tier(monkeypatch):
    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    rows = read_input(ROOT / "input" / "sample-5.csv", GROUP, STORES)[:2]
    result = run_batch(FakeClient(responder=responder), rows, GROUP, STORES, "test", deep_eans={rows[1].ean})
    assert [p.max_cost for p in result.products] == [0.10, 0.50]
    forced = run_batch(FakeClient(responder=responder), rows, GROUP, STORES, "test", max_cost=0.0)
    assert {o["limit_usd"] for o in forced.summary()["over_budget"]} == {0.0}


def test_saved_research_is_reused_only_if_good_enough():
    assert good_enough({"_tier": "deep"}, TIERS["economy"])
    assert good_enough({}, TIERS["economy"])  # saved before tiers existed = economy
    assert not good_enough({"_tier": "economy"}, TIERS["deep"])


@pytest.mark.db
def test_research_again_rebuilds_the_saved_input(monkeypatch):
    from db.models import Batch, Event
    from db.repo import engine, latest_product, save_batch
    from scripts.research_again import row_from_saved

    monkeypatch.setattr("pipeline.generate.load_glossary", lambda lang: {})
    rows = read_input(ROOT / "input" / "sample-5.csv", GROUP, STORES)[:1]
    batch_id = save_batch(run_batch(FakeClient(responder=responder), rows, GROUP, STORES, "test"))
    try:
        saved = latest_product(rows[0].ean)
        assert saved["stores"] == STORES and saved["group"] == "group-1" and saved["batch_id"] == batch_id
        row = row_from_saved(saved, "deep")
        assert (row.name, row.ml, row.tester, row.prices, row.tier) == (
            rows[0].name,
            rows[0].ml,
            rows[0].tester,
            rows[0].prices,
            "deep",
        )
    finally:
        with Session(engine()) as session, session.begin():
            session.execute(delete(Event).where(Event.batch_id == batch_id))
            session.execute(delete(Batch).where(Batch.id == batch_id))
