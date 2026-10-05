import pytest

from pipeline.ai import FALLBACK_BETA, MODEL, AIError, ask
from pipeline.config import load_group
from pipeline.input import InputRow
from pipeline.research import fact_field, research_product
from tests.fake_ai import FakeClient, message

A, B, C = "https://www.fragrantica.com/x", "https://www.notino.gr/y", "https://brand.com/z"
SCHEMA = {"type": "object", "properties": {}, "additionalProperties": False}


def src(url, supports=True, says="Eau de Parfum"):
    return {"url": url, "says": says, "supports": supports}


def research_answer(**overrides):
    fact = {"value": "Eau de Parfum", "sources": [src(A), src(B)]}
    data = {
        "brand": {"value": "Paco Rabanne", "sources": [src(A, says="Paco Rabanne"), src(C, says="Paco Rabanne")]},
        "name": {"value": "Lady Million Empire", "sources": [src(A), src(B)]},
        "concentration": fact,
        "gender": {"value": "Women's Perfume", "sources": [src(A, says="for women"), src(B, says="Dámská")]},
        "fragrance_family": {"value": "Amber Floral", "sources": [src(A, says="Amber Floral")]},
        "top_note": {"value": ["sicilian lemon"], "sources": [src(A), src(B)]},
        "middle_note": {"value": ["rose"], "sources": [src(A), src(B, supports=False, says="jasmine")]},
        "base_note": {"value": ["vanilla"], "sources": [src(A), src("https://invented.example/p")]},
        "ingredients": {"value": "", "sources": []},
        "images": [{"url": C + ".png", "width": 2000, "height": 2000, "source": "brand.com"}],
        "matches_input": True,
        "problem": "",
    }
    data.update(overrides)
    return data


ROW = InputRow(line=2, name="Paco Rabanne Lady Million Empire EDP", ml=80, tester=False, ean="3349668571970", prices={})


def test_ask_sends_model_fallback_effort_schema_and_web_tools():
    client = FakeClient(message({"ok": True}))
    result = ask(client, system="s", prompt="p", schema=SCHEMA, effort="high", web=True)
    call = client.calls[0]
    assert call["model"] == MODEL
    assert call["betas"] == [FALLBACK_BETA] and call["fallbacks"] == "default"
    assert call["output_config"]["effort"] == "high"
    assert call["output_config"]["format"]["schema"] == SCHEMA
    assert {t["name"] for t in call["tools"]} == {"web_search", "web_fetch"}
    assert result.data == {"ok": True}


def test_ask_resumes_pause_turn_and_sums_usage():
    client = FakeClient(message(stop_reason="pause_turn", searches=3), message({"ok": 1}, searches=2))
    result = ask(client, system="s", prompt="p", schema=SCHEMA, web=True)
    assert len(client.calls) == 2
    assert client.calls[1]["messages"][1]["role"] == "assistant"  # paused turn resent, no extra user message
    assert result.usage.web_searches == 5
    assert result.usage.cost_usd == pytest.approx(2 * (1000 * 4 + 500 * 20) / 1e6 + 5 * 0.01)


@pytest.mark.parametrize(
    ("msg", "text"),
    [
        (message(stop_reason="refusal", category="bio", text=""), "отказа"),
        (message(stop_reason="max_tokens", text="{"), "прекъснат"),
        (message(text="not json"), "невалиден JSON"),
    ],
)
def test_ask_turns_bad_endings_into_clear_errors(msg, text):
    with pytest.raises(AIError, match=text):
        ask(FakeClient(msg), system="s", prompt="p", schema=SCHEMA)


def test_status_rules_for_facts():
    seen = {A, B, C}
    two = fact_field("name", {"value": "X", "sources": [src(A), src(B)]}, seen)
    assert (two.status, two.confidence) == ("ok", 0.9)
    same_site = fact_field("name", {"value": "X", "sources": [src(A), src(A + "?2")]}, seen)
    assert same_site.status == "suggested"  # one website twice is still one source
    disagree = fact_field("name", {"value": "X", "sources": [src(A), src(B), src(C, False, "Y")]}, seen)
    assert (disagree.status, disagree.alternatives) == ("suggested", ["Y"])
    assert "brand.com" in disagree.message


def test_invented_urls_do_not_count():
    f = fact_field("base_note", {"value": ["vanilla"], "sources": [src(A), src("https://invented.example/p")]}, {A})
    assert f.status == "suggested"
    assert [s["url"] for s in f.sources] == [A]
    assert f.issues[0]["rule"] == "unverified_source"


def test_research_product_end_to_end():
    client = FakeClient(message(research_answer(), urls=[A, B, C], searches=4))
    r = research_product(client, ROW, load_group("group-1"))
    assert r.fields["brand"].status == "ok"
    assert r.fields["fragrance_family"].status == "suggested"  # one source
    assert r.fields["middle_note"].alternatives == ["jasmine"]
    assert r.fields["base_note"].status == "suggested"  # second source invented
    assert r.fields["ingredients"].value == "" and r.fields["ingredients"].status == "suggested"
    assert r.usage.web_searches == 4
    schema = client.calls[0]["output_config"]["format"]["schema"]
    assert "Woody Spicy" in schema["properties"]["fragrance_family"]["properties"]["value"]["enum"]
    assert "EAN: 3349668571970" in client.calls[0]["messages"][0]["content"]


def test_mismatch_and_refusal_block_the_product():
    client = FakeClient(message(research_answer(matches_input=False, problem="EAN is Black XS"), urls=[A, B, C]))
    r = research_product(client, ROW, load_group("group-1"))
    assert r.fields["name"].status == "blocked" and "Black XS" in r.fields["name"].message
    r = research_product(FakeClient(message(stop_reason="refusal", text="")), ROW, load_group("group-1"))
    assert r.error and all(f.status == "blocked" for f in r.fields.values())


def test_default_client_ignores_a_host_base_url(monkeypatch):
    from pipeline.ai import API_URL, default_client

    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://host-tool.invalid")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.delenv("PERFUME_ANTHROPIC_BASE_URL", raising=False)
    assert str(default_client().base_url).rstrip("/") == API_URL


def test_api_key_prefers_the_project_variable(monkeypatch):
    from pipeline.ai import api_key

    monkeypatch.setenv("ANTHROPIC_API_KEY", "generic")
    monkeypatch.setenv("PERFUME_ANTHROPIC_API_KEY", "project")
    assert api_key() == "project"
    monkeypatch.delenv("PERFUME_ANTHROPIC_API_KEY")
    assert api_key() == "generic"
