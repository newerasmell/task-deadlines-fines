"""Research tiers: how much a product's research and texts may cost (docs/decisions.md #9).

economy: many products at once or the whole catalog; search snippets only, texts through the Batches API.
deep: important products; Opus 5.5 reads a few pages, texts right away. Chosen per batch, per selected
products, or per product afterwards (scripts/research_again.py).
"""

from dataclasses import dataclass

SONNET = "claude-sonnet-5-5"
OPUS = "claude-opus-5-5"
NO_THINKING = {"type": "between_tools"}  # Sonnet 5.5's lowest thinking setting (needs effort <= high)
OVERRUN = 0.20  # a product may go at most 20% over its limit; a step that would pass that is skipped


def ceiling(limit: float) -> float:
    return round(limit * (1 + OVERRUN), 4)


@dataclass(frozen=True)
class Tier:
    name: str
    label: str  # Bulgarian, for CLI output and the app
    model: str
    searches: int
    fetches: int  # pages read in full; 0 = search snippets only
    fetch_max_tokens: int
    research_effort: str
    research_max_tokens: int
    text_model: str
    text_thinking: dict | None  # None = the model's default (Opus 5.5 cannot turn thinking off)
    text_batch: bool  # texts through the Message Batches API at half price
    max_cost: float  # USD per product, everything included; hard ceiling = ceiling(max_cost)
    text_cost: float  # expected USD per text (English master or one translation), measured on live runs
    image_search: bool = True  # one small extra lookup when research brought no working packshot
    image_search_cost: float = 0.045

    def web_tools(self) -> list[dict]:
        tools = [{"type": "web_search_20260209", "name": "web_search", "max_uses": self.searches}]
        if self.fetches:
            tools.append(
                {
                    "type": "web_fetch_20260209",
                    "name": "web_fetch",
                    "max_uses": self.fetches,
                    "max_content_tokens": self.fetch_max_tokens,
                }
            )
        return tools


TIERS = {
    "economy": Tier(
        name="economy",
        label="евтино",
        model=SONNET,
        searches=3,
        fetches=0,
        fetch_max_tokens=0,
        research_effort="low",
        research_max_tokens=8000,
        text_model=SONNET,
        text_thinking=NO_THINKING,
        text_batch=True,
        max_cost=0.10,
        text_cost=0.005,
    ),
    "deep": Tier(
        name="deep",
        label="задълбочено",
        model=OPUS,
        searches=6,
        fetches=4,
        fetch_max_tokens=6000,
        research_effort="high",
        research_max_tokens=16000,
        text_model=OPUS,
        text_thinking=None,
        text_batch=False,
        max_cost=0.50,
        text_cost=0.02,
    ),
}
DEFAULT_TIER = "economy"
ALIASES = {
    "": None,
    "economy": "economy",
    "евтино": "economy",
    "cheap": "economy",
    "deep": "deep",
    "задълбочено": "deep",
}


def tier(name: str | None) -> Tier:
    key = ALIASES.get((name or "").strip().lower(), (name or "").strip().lower()) or DEFAULT_TIER
    if key not in TIERS:
        raise KeyError(f"Непознат режим „{name}“. Възможни: {', '.join(TIERS)}.")
    return TIERS[key]
