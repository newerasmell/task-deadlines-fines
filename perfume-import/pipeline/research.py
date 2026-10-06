"""Research one product once (SPEC §4); the result is reused by every store.

The model searches the web and returns facts with sources. Code, not the model, decides the status:
a fact is ok only when at least two different websites support it, and only URLs that the web tools actually
returned count as sources (an invented URL is ignored). Price never comes from here; an EAN only as a sourced
suggestion when the input EAN belongs to another size or product (decision #10), never written over the input.
"""

import re
from dataclasses import dataclass, field
from urllib.parse import urlparse

from pipeline import ean
from pipeline.ai import AIError, Usage, ask
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
- Always run web_search before answering. Never answer from memory: an answer without a search is rejected.
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
- Research the fragrance by its name and volume, even when the EAN in the request looks wrong.
- mismatch: "none" when the request's EAN belongs to this fragrance at this volume (or nothing contradicts it);
  "ean" when sources show the EAN belongs to another size, edition, set or product; "product" only when the
  name itself identifies no product or several equally. Explain any mismatch in problem.
- ean_for_volume: the EAN a source literally shows for this fragrance, concentration and volume (the tester EAN
  if the request is a tester and one is shown), with its sources; an empty string when no result shows it."""


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
        "mismatch": {"type": "string", "enum": ["none", "ean", "product"]},
        "problem": {"type": "string"},
        "ean_for_volume": _fact({"type": "string"}),
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
        elif fact["sources"]:
            f.message = "Няма проверим източник."
        else:
            f.message = "Без нито един източник: вероятно по памет на модела. Провери."
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
class EanCheck:
    problem: str
    suggestion: Field  # value "" when no source shows the EAN for this volume


@dataclass
class Research:
    fields: dict[str, Field]
    images: list[dict]
    raw: dict
    usage: Usage = field(default_factory=Usage)
    error: str | None = None
    ean_check: "EanCheck | None" = None  # the input EAN belongs to another size or product

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


NO_SEARCH_RETRY = "\n\nYour previous answer ran no web search. Search now; answer only from the results."


def research_product(
    client, row: InputRow, group: Group, tier: Tier | None = None, budget: float | None = None
) -> Research:
    tier = tier or TIERS[DEFAULT_TIER]
    spent, result = Usage(), None
    try:
        # At low effort the model sometimes answers from memory without one search: nothing it says is then
        # verifiable. Asked once more, insisting; a second answer without a search is kept but has no sources.
        for attempt in range(2):
            result = ask(
                client,
                system=system_prompt(tier),
                prompt=prompt(row) + (NO_SEARCH_RETRY if attempt else ""),
                schema=schema(group),
                effort=tier.research_effort,
                web=True,
                tools=tier.web_tools(),
                model=tier.model,
                max_tokens=tier.research_max_tokens,
                budget=None if budget is None else budget - spent.cost,
            )
            spent.add(result.usage)
            if result.sources or result.usage.web_searches:
                break
    except AIError as exc:
        blocked = {
            k: Field(key=k, value=None, origin="ai_research", status="blocked", message=str(exc)) for k in FACT_KEYS
        }
        return Research(fields=blocked, images=[], raw={}, usage=spent, error=str(exc))
    result.usage = spent
    data = result.data
    seen = {s["url"] for s in result.sources}
    fields = {k: fact_field(k, data[k], seen) for k in FACT_KEYS}
    strip_brand(fields)
    research = Research(
        fields=fields,
        images=data["images"],
        raw={**data, "_sources_seen": sorted(seen)},
        usage=result.usage,
    )
    _mismatch(research, data, seen)
    return research


def from_saved(raw: dict) -> Research:
    """Reuse research stored in products.research (same EAN researched earlier) without paying again."""
    seen = set(raw.get("_sources_seen", []))
    fields = {k: fact_field(k, raw[k], seen) for k in FACT_KEYS if k in raw}
    strip_brand(fields)
    research = Research(fields=fields, images=raw.get("images", []), raw=raw)
    _mismatch(research, raw, seen)
    return research


def mismatch_kind(raw: dict) -> str:
    """Research saved before the "mismatch" key had only matches_input; false then meant another product."""
    if "mismatch" in raw:
        return raw["mismatch"]
    return "product" if raw.get("matches_input") is False else "none"


def _mismatch(research: Research, raw: dict, seen: set[str]) -> None:
    """A wrong EAN does not stop the product (decision #10): the fragrance is researched by its name and the
    EAN is flagged with the EAN the sources give for this volume. Only an unidentifiable name blocks."""
    kind, problem = mismatch_kind(raw), raw.get("problem") or ""
    if kind == "product":
        research.fields["name"].flag("blocked", f"Продуктът не съвпада с входа: {problem}", "research_mismatch")
    elif kind == "ean":
        found = raw.get("ean_for_volume") or {"value": "", "sources": []}
        suggestion = fact_field("ean", {**found, "value": ean.clean(found["value"] or "")}, seen)
        if suggestion.value and ean.problem(suggestion.value):
            suggestion.value = ""
        research.ean_check = EanCheck(problem=problem, suggestion=suggestion)


IMAGE_SYSTEM = """You find packshot images for one perfume for an online shop.
Search results never contain image URLs, so: one web search to find the product page, then always open one page
with web_fetch: the brand's official product page, or a large retailer's product page (Notino, Douglas, Sephora,
Lookfantastic). Take the image file URLs (.jpg, .png, .webp; og:image and the product gallery) from that page,
largest version first, official site first. Never build or guess a URL."""

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
    code = row.ean if not research.ean_check else research.ean_check.suggestion.value  # never the wrong EAN
    volume = f"\nVolume: {row.ml:g} ml" if row.ml else ""
    prompt = f"Perfume: {product}{volume}\nEAN: {code or 'unknown'}\nFind its packshot image URLs."
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


FRAGRANTICA_PAGE = re.compile(r"fragrantica\.[a-z.]+/perfume/[^?#]*?-(\d+)\.html", re.I)


def fragrantica_bottle(research: Research) -> list[dict]:
    """Free last resort: Fragrantica's bottle picture for a perfume page the research saw. Often under 1000 px,
    so it only ever comes in as a warning; the download check still decides whether it is real."""
    urls = list(research.raw.get("_sources_seen", []))
    urls += [s["url"] for f in research.fields.values() for s in f.sources]
    ids = dict.fromkeys(m.group(1) for u in urls if (m := FRAGRANTICA_PAGE.search(u)))
    return [{"url": f"https://fimgs.net/mdimg/perfume/o.{i}.jpg", "source": "fragrantica.com"} for i in ids]
