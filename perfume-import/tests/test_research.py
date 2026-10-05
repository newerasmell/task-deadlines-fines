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


def test_ask_sends_model_fallback_effort_schema_and_search_only():
    client = FakeClient(message({"ok": True}))
    result = ask(client, system="s", prompt="p", schema=SCHEMA, effort="low", web=True)
    call = client.calls[0]
    assert call["model"] == MODEL == "claude-sonnet-5-5"
    assert call["betas"] == [FALLBACK_BETA] and call["fallbacks"] == "default"
    assert call["output_config"]["effort"] == "low"
    assert call["output_config"]["format"]["schema"] == SCHEMA
    assert call["cache_control"] == {"type": "ephemeral"}
    assert call["tools"] == [{"type": "web_search_20260209", "name": "web_search", "max_uses": 3}]
    assert "thinking" not in call
    assert result.data == {"ok": True}


def test_ask_without_web_sends_no_tools_and_can_turn_thinking_off():
    client = FakeClient(message({"ok": True}))
    ask(client, system="s", prompt="p", schema=SCHEMA, thinking={"type": "between_tools"})
    assert "tools" not in client.calls[0]
    assert client.calls[0]["thinking"] == {"type": "between_tools"}


def test_ask_resumes_pause_turn_and_sums_usage():
    client = FakeClient(message(stop_reason="pause_turn", searches=3), message({"ok": 1}, searches=2))
    result = ask(client, system="s", prompt="p", schema=SCHEMA, web=True)
    assert len(client.calls) == 2
    assert client.calls[1]["messages"][1]["role"] == "assistant"  # paused turn resent, no extra user message
    assert result.usage.web_searches == 5
    assert result.usage.cost_usd == pytest.approx(2 * (1000 * 2 + 500 * 10) / 1e6 + 5 * 0.01)  # Sonnet 5.5


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


def test_ask_turns_api_errors_into_ai_error():
    import anthropic
    import httpx

    class Failing(FakeClient):
        def _stream(self, **kwargs):
            raise anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com"))

    with pytest.raises(AIError, match="Claude API"):
        ask(Failing(), system="s", prompt="p", schema=SCHEMA)
    r = research_product(Failing(), ROW, load_group("group-1"))
    assert r.error and all(f.status == "blocked" for f in r.fields.values())


def test_schema_shares_the_sources_list():
    # Inlining the sources list in every fact made the API reject the schema ("compiled grammar is too large").
    from pipeline.research import schema

    s = schema(load_group("group-1"))
    assert "items" in s["$defs"]["sources"]
    facts = [v for v in s["properties"].values() if "sources" in v.get("properties", {})]
    assert len(facts) == 9 and all(f["properties"]["sources"] == {"$ref": "#/$defs/sources"} for f in facts)


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


def test_ask_batch_matches_results_by_id_and_halves_token_cost():
    from pipeline.ai import ask_batch, params

    client = FakeClient(responder=lambda body: message({"echo": body["messages"][0]["content"]}))
    body = params(system="s", prompt="a", schema=SCHEMA, effort="low", max_tokens=100)
    results = ask_batch(
        client, {"x": body, "y": {**body, "messages": [{"role": "user", "content": "b"}]}}, poll_seconds=0
    )
    assert results["x"].data == {"echo": "a"} and results["y"].data == {"echo": "b"}
    assert results["x"].usage.cost_usd == pytest.approx((1000 * 2 + 500 * 10) / 1e6 * 0.5)
    assert client.batches == [["x", "y"]]


def test_brand_is_removed_from_the_name():
    client = FakeClient(
        message(
            research_answer(
                brand={"value": "Giorgio Armani", "sources": [src(A, says="Giorgio Armani"), src(B, says="Armani")]},
                name={"value": "Armani Code Profumo", "sources": [src(A), src(B)]},
            ),
            urls=[A, B, C],
        )
    )
    r = research_product(client, ROW, load_group("group-1"))
    assert r.fields["name"].value == "Code Profumo"
    assert (r.fields["name"].status, r.fields["name"].previous) == ("fixed", "Armani Code Profumo")
