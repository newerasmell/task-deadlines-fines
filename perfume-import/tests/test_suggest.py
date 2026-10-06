import pytest
from sqlalchemy import delete
from sqlalchemy.orm import Session

from pipeline.config import load_group
from pipeline.suggest import build_glossary, suggest_vocab
from tests.fake_ai import FakeClient, message

FAMILIES = list(load_group("group-1").vocab["fragrance_family"])


def test_vocab_suggestions_use_only_the_vocab_and_asked_values():
    answer = {
        "items": [
            {
                "variant": "Ανατολίτικη λουλουδάτη",
                "canonical": "Oriental Floral",
                "confidence": 0.95,
                "reason": "Greek",
            },
            {"variant": "Duhan", "canonical": "NONE", "confidence": 1.4, "reason": "tobacco"},
            {"variant": "Invented", "canonical": "Floral", "confidence": 0.9, "reason": "?"},
        ]
    }
    client = FakeClient(message(answer))
    s = suggest_vocab(client, "fragrance_family", {"Ανατολίτικη λουλουδάτη": 6, "Duhan": 1}, FAMILIES)
    enum = client.calls[0]["output_config"]["format"]["schema"]["properties"]["items"]["items"]["properties"][
        "canonical"
    ]["enum"]
    assert "Woody Spicy" in enum and "NONE" in enum
    assert [(i["variant"], i["canonical"], i["count"]) for i in s.items] == [
        ("Ανατολίτικη λουλουδάτη", "Oriental Floral", 6),
        ("Duhan", None, 1),
    ]
    assert s.items[1]["confidence"] == 1.0


def test_glossary_accepts_only_confirmed_consistent_pairs():
    pairs = {
        "βανίλια": {"translation": "vanilija", "count": 27, "consistency": 1.0},
        "κεχριμπάρι": {"translation": "jantar", "count": 24, "consistency": 0.458},
        "μόσχος": {"translation": "mošus", "count": 25, "consistency": 1.0},
        "μοσχος λευκος": {"translation": "bijeli mošus", "count": 2, "consistency": 1.0},
    }
    answer = {
        "items": [
            {"a": "βανίλια", "b": "vanilija", "en": "Vanilla", "a_ok": True, "b_ok": True},
            {"a": "κεχριμπάρι", "b": "jantar", "en": "amber", "a_ok": True, "b_ok": True},
            {"a": "μόσχος", "b": "mošus", "en": "musk", "a_ok": True, "b_ok": False},
            {"a": "μοσχος λευκος", "b": "bijeli mošus", "en": "white musk", "a_ok": True, "b_ok": True},
        ]
    }
    el, hr, pending, usage = build_glossary(FakeClient(message(answer)), pairs, "el", "hr")
    assert el == {"vanilla": "βανίλια", "white musk": "μοσχος λευκος"}
    assert hr == {"vanilla": "vanilija", "white musk": "bijeli mošus"}
    assert "постоянна" in pending["amber"]["why"] and "hr превод" in pending["musk"]["why"]
    assert usage.cost_usd > 0


def test_two_pairs_for_one_english_term_go_to_pending():
    pairs = {
        "βανίλια": {"translation": "vanilija", "consistency": 1.0},
        "βανιλια": {"translation": "vanilija", "consistency": 1.0},
    }
    answer = {
        "items": [
            {"a": "βανίλια", "b": "vanilija", "en": "vanilla", "a_ok": True, "b_ok": True},
            {"a": "βανιλια", "b": "vanilija", "en": "vanilla", "a_ok": True, "b_ok": True},
        ]
    }
    el, hr, pending, _ = build_glossary(FakeClient(message(answer)), pairs, "el", "hr")
    assert el == {} and pending["vanilla"]["el"] == ["βανίλια", "βανιλια"]


@pytest.mark.db
def test_vocab_suggestions_are_saved_as_suggested_and_respect_decisions():
    from db.models import VocabLearned
    from db.repo import engine, save_vocab_suggestions

    group = "test-group"
    items = {
        "fragrance_family": [
            {"variant": "Drvenasta", "canonical": "Woody", "confidence": 0.9, "reason": "hr", "count": 3}
        ]
    }
    try:
        assert save_vocab_suggestions(group, items) == 1
        with Session(engine()) as session, session.begin():
            row = session.query(VocabLearned).filter_by(group_key=group).one()
            assert (row.status, row.canonical, row.hits) == ("suggested", "Woody", 3)
            row.status = "rejected"
        assert save_vocab_suggestions(group, items) == 0  # a person's decision is never overwritten
    finally:
        with Session(engine()) as session, session.begin():
            session.execute(delete(VocabLearned).where(VocabLearned.group_key == group))
