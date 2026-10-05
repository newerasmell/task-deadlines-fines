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
from pipeline.titles import CONCENTRATIONS

NOTE_KEYS = ("top_note", "middle_note", "base_note")
FACT_KEYS = ("brand", "name", "concentration", "gender", "fragrance_family", *NOTE_KEYS, "ingredients")

SYSTEM = """You research one perfume for an online shop catalog. Use web search and web fetch.
Preferred sources: the brand's official site, Fragrantica, Parfumo, major retailers (Notino, Douglas, Sephora).
Rules:
- Every fact needs sources: for each source give its URL, what it literally says, and whether it supports the
  value you chose. Try to find two independent websites for each fact.
- gender and fragrance_family: pick only from the allowed values given. Put the source's own wording in "says".
- Notes are English canonical names, lowercase (e.g. "bergamot", "pink pepper").
- concentration: the official full form (e.g. "Eau de Parfum").
- name: the fragrance name without brand, concentration, volume or "tester".
- ingredients: the published ingredient list (INCI) if you find one, else an empty string with no sources.
- images: official packshot URLs, largest available, with width/height if known (0 if unknown).
- Never invent an EAN, a price, a launch year or a perfumer. If sources disagree, choose the better-supported
  value and list the disagreeing source with supports=false.
- If the EAN or name in the request clearly belongs to a different product, set matches_input=false and explain."""


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


def research_product(client, row: InputRow, group: Group) -> Research:
    try:
        result: Result = ask(client, system=SYSTEM, prompt=prompt(row), schema=schema(group), effort="high", web=True)
    except AIError as exc:
        blocked = {
            k: Field(key=k, value=None, origin="ai_research", status="blocked", message=str(exc)) for k in FACT_KEYS
        }
        return Research(fields=blocked, images=[], raw={}, error=str(exc))
    data = result.data
    seen = {s["url"] for s in result.sources}
    fields = {k: fact_field(k, data[k], seen) for k in FACT_KEYS}
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
    if raw.get("matches_input") is False:
        fields["name"].flag("blocked", f"Продуктът не съвпада с входа: {raw.get('problem')}", "research_mismatch")
    return Research(fields=fields, images=raw.get("images", []), raw=raw)
