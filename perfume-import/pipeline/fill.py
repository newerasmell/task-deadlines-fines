"""Filling in only what a product is missing (notes, ingredients, family…), from a page a person links or from
a short targeted search, instead of researching the whole product again.

The answer has the same shape and rules as research (pipeline/research.py): every fact with its sources, notes
as English canonical names; nothing is guessed, an EAN is never written (only offered). Notes are then
translated per language with the glossary first and one small call for the terms it does not know.
"""

from pipeline.ai import AIError, Result, Usage, ask
from pipeline.config import Group, load_glossary
from pipeline.generate import LANGUAGE_NAMES
from pipeline.research import RULES, SOURCES, fact_field, schema
from pipeline.tiers import NO_THINKING, SONNET

# Field key in the store -> research key; the EAN is only offered (ean_for_volume), never filled.
FILLABLE = {
    "vendor": "brand",
    "name": "name",
    "concentration": "concentration",
    "gender": "gender",
    "fragrance_family": "fragrance_family",
    "top_note": "top_note",
    "middle_note": "middle_note",
    "base_note": "base_note",
    "ingredients": "ingredients",
    "ean": "ean_for_volume",
}

FROM_PAGE = """You complete a perfume shop's product data from one web page. Open the given URL with web_fetch and
take the requested facts from it; if the page does not show a fact, leave it empty with no sources (never take
it from memory). If the page lists the notes without top/middle/base, put them all in middle_note."""

FROM_SEARCH = """You complete a perfume shop's product data. Search the web (at most 3 searches, then open at most
one page with web_fetch, the Fragrantica page or the brand's product page) for only the requested facts.
If sources list the notes without top/middle/base, put them all in middle_note. Never answer from memory."""


def _schema(group: Group, keys: list[str]) -> dict:
    full = schema(group)
    props = {k: full["properties"][k] for k in keys}
    return {
        "type": "object",
        "properties": props,
        "required": list(props),
        "additionalProperties": False,
        "$defs": {"sources": SOURCES},
    }


def find_missing(
    client, product: str, ml: float | None, keys: list[str], group: Group, url: str | None = None
) -> tuple[dict, Result]:
    """{research key: Field} for the asked research keys, with the AI result (usage, sources seen)."""
    tools = [{"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 2, "max_content_tokens": 8000}]
    if not url:
        tools.insert(0, {"type": "web_search_20260209", "name": "web_search", "max_uses": 3})
    prompt = (
        f"Product: {product}"
        + (f"\nVolume: {ml:g} ml" if ml else "")
        + f"\nFill only: {', '.join(keys)}"
        + (f"\nPage: {url}" if url else "")
    )
    result = ask(
        client,
        system=(FROM_PAGE if url else FROM_SEARCH) + "\n" + RULES,
        prompt=prompt,
        schema=_schema(group, keys),
        effort="low",
        web=True,
        tools=tools,
        model=SONNET,
        max_tokens=8000,
        budget=0.15,
    )
    seen = {s["url"] for s in result.sources} | ({url} if url else set())
    return {k: fact_field(k, result.data[k], seen) for k in keys}, result


def translate_terms(client, terms: list[str], language: str) -> tuple[dict[str, str], Usage]:
    """English note names -> local, glossary first; one small call for the rest. Lowercase."""
    glossary = load_glossary(language)
    out = {t: glossary[t.lower()] for t in terms if t.lower() in glossary}
    unknown = [t for t in terms if t.lower() not in glossary]
    if not unknown or language == "en":
        return {**out, **{t: t for t in unknown}}, Usage()
    name = LANGUAGE_NAMES.get(language, language)
    item = {
        "type": "object",
        "properties": {"en": {"type": "string"}, "local": {"type": "string"}},
        "required": ["en", "local"],
        "additionalProperties": False,
    }
    try:
        result = ask(
            client,
            system=f"Translate perfume note names into {name} as a perfumer would name them, lowercase.",
            prompt="Notes: " + ", ".join(unknown),
            schema={
                "type": "object",
                "properties": {"notes": {"type": "array", "items": item}},
                "required": ["notes"],
                "additionalProperties": False,
            },
            effort="low",
            model=SONNET,
            thinking=NO_THINKING,
            max_tokens=2000,
        )
    except AIError:
        return {**out, **{t: t for t in unknown}}, Usage()
    found = {n["en"].lower(): n["local"].lower() for n in result.data["notes"]}
    return {**out, **{t: found.get(t.lower(), t) for t in unknown}}, result.usage


def normalize_notes(client, text: str) -> tuple[list[str], Usage]:
    """Notes as a person pasted them (any language, with descriptions in brackets, comma or line separated) ->
    English canonical note names, lowercase, in order."""
    result = ask(
        client,
        system=(
            "Extract the perfume notes from the text as English canonical note names, lowercase (e.g. "
            '"black tea", "pink pepper"). Drop descriptions, percentages and words that are not notes; translate '
            "notes written in another language; keep their order; no duplicates."
        ),
        prompt=text,
        schema={
            "type": "object",
            "properties": {"notes": {"type": "array", "items": {"type": "string"}}},
            "required": ["notes"],
            "additionalProperties": False,
        },
        effort="low",
        model=SONNET,
        thinking=NO_THINKING,
        max_tokens=2000,
    )
    notes = list(dict.fromkeys(n.strip().lower() for n in result.data["notes"] if n.strip()))
    return notes, result.usage


def translate_html(client, html: str, language: str) -> tuple[str, Usage]:
    """A product description from another store, translated into this store's language; HTML tags, brand and
    fragrance names kept."""
    name = LANGUAGE_NAMES.get(language, language)
    result = ask(
        client,
        system=(
            f"Translate this perfume shop product description into {name}. Keep the HTML tags exactly, keep brand "
            "and fragrance names as written, keep every fact and add none. Return only the translated HTML."
        ),
        prompt=html,
        schema={
            "type": "object",
            "properties": {"html": {"type": "string"}},
            "required": ["html"],
            "additionalProperties": False,
        },
        effort="low",
        model=SONNET,
        thinking=NO_THINKING,
        max_tokens=6000,
    )
    return result.data["html"], result.usage
