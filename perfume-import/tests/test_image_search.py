"""The cheap image lookup runs only when research brought no packshot that downloads."""

from pipeline.batch import research_step
from pipeline.config import load_group
from pipeline.images import FetchError
from pipeline.tiers import TIERS
from tests.conftest import png
from tests.fake_ai import FakeClient, message
from tests.test_research import ROW, A, B, C, research_answer

GROUP = load_group("group-1")
FOUND = "https://www.notino.gr/img/lady-million-empire.jpg"


def responder(kwargs):
    if "packshot images" in kwargs["system"]:
        return message({"images": [{"url": FOUND, "source": "notino.gr"}]}, urls=[A])
    return message(research_answer(images=[]), urls=[A, B, C])


def test_lookup_runs_when_research_has_no_image():
    client = FakeClient(responder=responder)
    result = research_step(client, ROW, GROUP, tier=TIERS["economy"])
    lookup = client.calls[1]
    assert lookup["model"] == "claude-sonnet-5-5" and lookup["thinking"] == {"type": "between_tools"}
    tools = {t["name"]: t for t in lookup["tools"]}
    assert tools["web_search"]["max_uses"] == 1 and tools["web_fetch"]["max_content_tokens"] == 4000
    assert "Paco Rabanne Lady Million Empire Eau de Parfum" in lookup["messages"][0]["content"]
    assert [c.url for c in result.images if c.ok] == [FOUND]
    assert "image_search" in result.usage
    assert result.research.raw["images"][0]["url"] == FOUND  # kept for reuse


def test_no_lookup_when_research_image_downloads():
    client = FakeClient(message(research_answer(), urls=[A, B, C]))
    result = research_step(client, ROW, GROUP, tier=TIERS["economy"])
    assert len(client.calls) == 1 and "image_search" not in result.usage


def test_lookup_runs_when_every_research_image_fails(monkeypatch):
    def fetch(url):
        if url == FOUND:
            return png(1500, 1500)
        raise FetchError("404")

    monkeypatch.setattr("pipeline.images.fetch", fetch)

    def respond(kwargs):
        if "packshot images" in kwargs["system"]:
            return message({"images": [{"url": FOUND, "source": "notino.gr"}]})
        return message(research_answer(), urls=[A, B, C])  # its image 404s

    result = research_step(FakeClient(responder=respond), ROW, GROUP, tier=TIERS["economy"])
    ok = [c for c in result.images if c.ok]
    assert [c.url for c in ok] == [FOUND] and ok[0].height == 1500


def test_failed_lookup_leaves_the_image_blocked_with_the_reason():
    def respond(kwargs):
        if "packshot images" in kwargs["system"]:
            return message(stop_reason="refusal", text="")
        return message(research_answer(images=[]), urls=[A, B, C])

    result = research_step(FakeClient(responder=respond), ROW, GROUP, tier=TIERS["economy"])
    assert result.images == [] and "отказа" in result.research.raw["_image_search_error"]
