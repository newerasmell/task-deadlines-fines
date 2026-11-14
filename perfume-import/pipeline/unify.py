"""A product the team already sells in other stores, made for a store that lacks it: its facts come from those
live, approved copies instead of a new web research (docs/decisions.md #26).

One small call reads the copies (each in its store's language) and returns the canonical English facts in the
research format, each fact with the store pages that state it as sources. Facts two stores agree on are `ok`
(SPEC §3: 2+ independent sources), a fact from one store is a suggestion; nothing absent from every copy is
added. The result is used as the product's saved research, so the rest is a normal new product: each store's
text by its template, notes in its language, the picture from a live copy."""

import json

from pipeline.ai import Usage, ask
from pipeline.config import Group
from pipeline.research import CONCENTRATIONS, SOURCES, _fact
from pipeline.tiers import NO_THINKING, SONNET

SYSTEM = """The same perfume is sold live in several of our shops, in different languages; the team approved
these listings. Give its facts in English, the way the research for a new product would: brand, the fragrance's
name without brand, concentration and volume, concentration, gender and fragrance family from the allowed
values, top, middle and base notes as English canonical note names (lowercase), ingredients as listed. Translate,
never add: a fact no listing states stays empty with no sources. For every fact list each listing that states it
as a source: its url, what it says (its own wording), supports true when it says the same as your value, false
when it says something else."""


def unify_schema(group: Group) -> dict:
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
    }
    return {
        "type": "object",
        "properties": props,
        "required": list(props),
        "additionalProperties": False,
        "$defs": {"sources": SOURCES},
    }


def unify_facts(client, copies: list[dict], group: Group) -> tuple[dict, Usage]:
    """copies: one dict per live listing: url, language and its fields (title, vendor, gender, notes…, image).
    Returns research as products.research keeps it (pipeline.research.from_saved reads it) and the usage."""
    listings = [{k: v for k, v in c.items() if v not in (None, "") and k != "image"} for c in copies]
    result = ask(
        client,
        system=SYSTEM,
        prompt="Listings:\n" + json.dumps(listings, ensure_ascii=False, indent=1),
        schema=unify_schema(group),
        effort="low",
        model=SONNET,
        thinking=NO_THINKING,
        max_tokens=16000,  # seven copies with their sources outgrew 4000 (decisions #50)
    )
    raw = dict(result.data)
    images = [c["image"] for c in copies if str(c.get("image") or "").startswith("http")]
    raw.update(
        images=[{"url": url, "width": 0, "height": 0, "source": "live store"} for url in images],
        mismatch="none",
        problem="",
        ean_for_volume={"value": "", "sources": []},
        _sources_seen=[c["url"] for c in copies],
        _tier="economy",
        _from_stores=[c["url"] for c in copies],
    )
    return raw, result.usage
