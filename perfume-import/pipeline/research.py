"""Research one product once (SPEC §4); the result is reused by every store.

The model searches the web and returns facts with sources. Code, not the model, decides the status:
a fact is ok only when at least two different websites support it, and only URLs that the web tools actually
returned count as sources (an invented URL is ignored). EAN and price never come from here.
"""

from dataclasses import dataclass, field
from urllib.parse import urlparse

from pipeline.ai import AIError, Result, Usage, ask
from pipeline.config import Group
from pipeline.fields import Field
from pipeline.input import InputRow
from pipeline.tiers import DEFAULT_TIER, NO_THINKING, SONNET, TIERS, Tier
from pipeline.titles import CONCENTRATIONS

NOTE_KEYS = ("top_note", "middle_note", "base_note")
FACT_KEYS = ("brand", "name", "concentration", "gender", "fragrance_family", *NOTE_KEYS, "ingredients")

SEARCH_ONLY = """You research one perfume for an online shop catalog using web search (at most {searches} searches).
Search Fragrantica first, then one major retailer (Notino, Douglas, Sephora) or the brand's site. Work from the
search results; you cannot open pages, so cite the result URLs you were given."""

WITH_PAGES = """You research one perfume for an online shop catalog using web search (at most {searches} searches)
and web fetch (at most {fetches} pages). Search first; open only the pages that settle facts: the brand's
official product page, the Fragrantica page, and one major retailer (Notino, Douglas, Sephora). Prefer the
brand's site for concentration, notes, ingredients (INCI) and the official packshot."""

RULES = """Rules:
- Every fact needs sources: for each source give its URL, what it literally says, and whether it supports the
  value you chose. Two independent websites per fact when the results allow it.
- gender and fragrance_family: pick only from the allowed values given. Put the source's own wording in "says".
- Notes are English canonical names, lowercase (e.g. "bergamot", "pink pepper").
- concentration: the official full form (e.g. "Eau de Parfum").
- brand: the house name as on its packaging (e.g. "Giorgio Armani"). name: the fragrance name only, without
  the brand or any part of it, concentration, volume or "tester" (e.g. "Code Profumo", not "Armani Code Profumo").
- ingredients: the published ingredient list (INCI) if a result shows it, else an empty string with no sources.
- images: packshot image URLs seen in the results (official site first), with width/height if known (0 if not).
- Never invent an EAN, a price, a launch year or a perfumer. If sources disagree, choose the better-supported
  value and list the disagreeing source with supports=false.
- If the EAN or name in the request clearly belongs to a different product, set matches_input=false and explain."""


def system_prompt(tier: Tier) -> str:
    intro = WITH_PAGES if tier.fetches else SEARCH_ONLY
    return intro.format(searches=tier.searches, fetches=tier.fetches) + "\n" + RULES


SYSTEM = system_prompt(TIERS[DEFAULT_TIER])


SOURCES = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "url": {"type": "string"},
            "says": {"type": "string"},
            "supports": {"type": "boolean"},
        },
        "required": ["url", "says", "supports"],
        "additionalProperties": False,
    },
}


def _fact(value_schema: dict) -> dict:
    # The sources list is shared through $defs: inlined nine times, the API rejects the schema
    # ("compiled grammar is too large").
    return {
        "type": "object",
        "properties": {"value": value_schema, "sources": {"$ref": "#/$defs/sources"}},
        "required": ["value", "sources"],
        "additionalProperties": False,
    }


def schema(group: Group) -> dict:
    notes = {"type": "array", "items": {"type": "string"}}
    props = {
        "brand": _fact({"type": "string"}),
        "name": _fact({"type": "string"}),
        "concentration": _fact({"type": "string", "enum": CONCENTRATIONS}),
        "gender": _fact({"type": "string", "enum": list(group.vocab["gender"])}),
        "fragrance_family": _fact({"type": "string", "enum": list(group.vocab["fragrance_family"])}),
        "top_note": _fact(notes),
        "middle_note": _fact(notes),
        "base_note": _fact(notes),
        "ingredients": _fact({"type": "string"}),
        "images": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "width": {"type": "integer"},
                    "height": {"type": "integer"},
                    "source": {"type": "string"},
                },
                "required": ["url", "width", "height", "source"],
                "additionalProperties": False,
            },
        },
        "matches_input": {"type": "boolean"},
        "problem": {"type": "string"},
    }
    return {
        "type": "object",
        "properties": props,
        "required": list(props),
        "additionalProperties": False,
        "$defs": {"sources": SOURCES},
    }


def prompt(row: InputRow) -> str:
    lines = [f"Product: {row.name}"]
    if row.ml:
        lines.append(f"Volume: {row.ml:g} ml")
    lines.append(f"Tester: {'yes' if row.tester else 'no'}")
    lines.append(f"EAN: {row.ean or 'unknown'}")
    if row.notes:
        lines.append(f"Notes from the team: {row.notes}")
    return "\n".join(lines)


def _domain(url: str) -> str:
    host = urlparse(url).netloc.lower()
    return host[4:] if host.startswith("www.") else host


def fact_field(key: str, fact: dict, seen_urls: set[str], origin: str = "ai_research") -> Field:
    """SPEC §3: ai_research is ok when 2+ independent sources agree (confidence >= 0.9), else suggested."""
    verified = [
        s for s in fact["sources"] if s["url"] in seen_urls or _domain(s["url"]) in {_domain(u) for u in seen_urls}
    ]
    supporting = {_domain(s["url"]) for s in verified if s["supports"]}
    against = [s for s in verified if not s["supports"]]
    value = fact["value"]
    f = Field(
        key=key,
        value=value,
        origin=origin,
        status="suggested",
        sources=[{"url": s["url"], "says": s["says"], "supports": s["supports"]} for s in verified],
    )
    empty = value in ("", [], None)
    if empty:
        f.confidence = None
        f.message = "Не е намерено в източниците." if key != "ingredients" else "Няма публикуван списък със съставки."
        return f
    if len(supporting) >= 2 and not against:
        f.status, f.confidence = "ok", 0.9 if len(supporting) == 2 else 0.95
    else:
        f.confidence = 0.6 if supporting else 0.3
        if against:
            f.alternatives = sorted({s["says"] for s in against})
            f.message = "Източниците не са съгласни: " + "; ".join(
                f"{_domain(s['url'])} казва „{s['says']}“" for s in against
            )
        elif supporting:
            f.message = f"Само един източник ({next(iter(supporting))}). Провери."
        else:
            f.message = "Няма проверим източник."
    dropped = len(fact["sources"]) - len(verified)
    if dropped:
        f.issues.append(
            {
                "status": "suggested",
                "rule": "unverified_source",
                "message": f"{dropped} източника не са от търсенето и не се броят.",
            }
        )
    return f


@dataclass
class Research:
    fields: dict[str, Field]
    images: list[dict]
    raw: dict
    usage: Usage = field(default_factory=Usage)
    error: str | None = None

    def value(self, key: str):
        f = self.fields.get(key)
        return f.value if f else None


def strip_brand(fields: dict[str, Field]) -> None:
    """'Giorgio Armani' + 'Armani Code Profumo' would render 'Giorgio Armani Armani Code Profumo'.
    Drop the brand, or the last word of the brand, from the start of the name."""
    brand, name = fields.get("brand"), fields.get("name")
    if not brand or not name or not brand.value or not name.value:
        return
    words = str(brand.value).split()
    for prefix in dict.fromkeys([str(brand.value), words[-1]]):
        if str(name.value).casefold().startswith(prefix.casefold() + " "):
            cleaned = str(name.value)[len(prefix) + 1 :].strip()
            if cleaned:
                name.fix(cleaned, f"Махната марката от името: „{name.value}“ → „{cleaned}“.", "name_brand")
            return


def research_product(client, row: InputRow, group: Group, tier: Tier | None = None) -> Research:
    tier = tier or TIERS[DEFAULT_TIER]
    try:
        result: Result = ask(
            client,
            system=system_prompt(tier),
            prompt=prompt(row),
            schema=schema(group),
            effort=tier.research_effort,
            web=True,
            tools=tier.web_tools(),
            model=tier.model,
            max_tokens=tier.research_max_tokens,
        )
    except AIError as exc:
        blocked = {
            k: Field(key=k, value=None, origin="ai_research", status="blocked", message=str(exc)) for k in FACT_KEYS
        }
        return Research(fields=blocked, images=[], raw={}, error=str(exc))
    data = result.data
    seen = {s["url"] for s in result.sources}
    fields = {k: fact_field(k, data[k], seen) for k in FACT_KEYS}
    strip_brand(fields)
    if not data["matches_input"]:
        fields["name"].flag("blocked", f"Продуктът не съвпада с входа: {data['problem']}", "research_mismatch")
    return Research(
        fields=fields,
        images=data["images"],
        raw={**data, "_sources_seen": sorted(seen)},
        usage=result.usage,
    )


def from_saved(raw: dict) -> Research:
    """Reuse research stored in products.research (same EAN researched earlier) without paying again."""
    seen = set(raw.get("_sources_seen", []))
    fields = {k: fact_field(k, raw[k], seen) for k in FACT_KEYS if k in raw}
    strip_brand(fields)
    if raw.get("matches_input") is False:
        fields["name"].flag("blocked", f"Продуктът не съвпада с входа: {raw.get('problem')}", "research_mismatch")
    return Research(fields=fields, images=raw.get("images", []), raw=raw)


IMAGE_SYSTEM = """You find packshot images for one perfume for an online shop.
Use at most one web search and open at most one page: the brand's official product page, or a large retailer's
product page (Notino, Douglas, Sephora, Lookfantastic). Return direct image file URLs (.jpg, .png, .webp) that
appear in that page or in the results, largest version first, official site first. Never build or guess a URL."""

IMAGE_TOOLS = [
    {"type": "web_search_20260209", "name": "web_search", "max_uses": 1},
    {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 1, "max_content_tokens": 4000},
]

IMAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "images": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"url": {"type": "string"}, "source": {"type": "string"}},
                "required": ["url", "source"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["images"],
    "additionalProperties": False,
}


def find_images(client, row: InputRow, research: Research) -> tuple[list[dict], Usage, str | None]:
    """The cheap image lookup (decision #9): one search, one page, Sonnet without thinking. The download
    check in images.py decides whether a URL is real; nothing here is trusted on its own."""
    brand, name = research.value("brand") or "", research.value("name") or row.name
    concentration = research.value("concentration") or ""
    product = " ".join(x for x in (brand, name, concentration) if x)
    prompt = f"Perfume: {product}\nEAN: {row.ean or 'unknown'}\nFind its packshot image URLs."
    try:
        result = ask(
            client,
            system=IMAGE_SYSTEM,
            prompt=prompt,
            schema=IMAGE_SCHEMA,
            effort="low",
            web=True,
            tools=IMAGE_TOOLS,
            model=SONNET,
            thinking=NO_THINKING,
            max_tokens=2000,
        )
    except AIError as exc:
        return [], Usage(), str(exc)
    images = [{"url": i["url"], "width": 0, "height": 0, "source": i["source"]} for i in result.data["images"]]
    return images, result.usage, None
