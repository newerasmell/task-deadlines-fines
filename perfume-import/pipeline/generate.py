"""Generated prose (SPEC §5): an English master per product, then one localization per store language.

English is the master; every localized field keeps its English reference in `value_en` (CLAUDE.md #5).
Notes are translated by the glossary first; only unknown terms go to the model and come back as suggestions.
The tester sentence is fixed text from group.yaml, appended by code, never written by the model.
After each attempt the SPEC §7 checks run: wrong language -> retry up to 2 times then blocked;
length out of range -> one retry then warning.
"""

from dataclasses import dataclass, field

from pipeline import lang
from pipeline.ai import AIError, Usage, ask
from pipeline.config import Group, load_glossary
from pipeline.fields import Field

NOTE_KEYS = ("top_note", "middle_note", "base_note")
SEO_MAX = 160
LANGUAGE_RETRIES = 2

MASTER_SYSTEM = """You write product descriptions for a perfume shop. Write in English.
Follow this style guide exactly:
{guide}
Hard rules: plain text for the description (the shop wraps it in a single <p>), {lo}-{hi} characters;
an SEO description of at most 160 characters; only facts given to you, nothing invented; do not mention
that the product is a tester and do not mention price."""

LOCAL_SYSTEM = """You translate perfume shop texts from English into {language_name}.
Keep the meaning, tone and every fact; keep brand and fragrance names exactly as written; the description
must be {lo}-{hi} characters in {language_name}; the SEO description at most 160 characters.
Translate each listed perfume note as a perfumer would name it in {language_name}, lowercase."""

LANGUAGE_NAMES = {
    "en": "English",
    "el": "Greek",
    "hr": "Croatian",
    "cs": "Czech",
    "sk": "Slovak",
    "sl": "Slovenian",
    "hu": "Hungarian",
    "pl": "Polish",
    "et": "Estonian",
    "lt": "Lithuanian",
    "lv": "Latvian",
    "bg": "Bulgarian",
    "ro": "Romanian",
    "de": "German",
}


@dataclass
class Text:
    language: str
    description: str
    seo_description: str
    notes: dict[str, list[str]]  # note key -> local terms
    new_terms: dict[str, str] = field(default_factory=dict)  # english -> local, not yet in the glossary
    tester_sentence: str | None = None
    tester_sentence_is_new: bool = False
    problems: list[tuple[str, str, str]] = field(default_factory=list)  # (status, rule, message)
    usage: Usage = field(default_factory=Usage)


def _check(text: str, seo: str, language: str, lo: int, hi: int) -> tuple[bool, bool]:
    """-> (language ok, length ok)."""
    found = lang.detect(text)
    language_ok = found in (None, language)
    length_ok = lo <= len(text) <= hi and len(seo) <= SEO_MAX
    return language_ok, length_ok


def _attempts(client, *, system, prompt, schema, effort, language, lo, hi, usage: Usage):
    """Run until language and length pass; returns (data, problems)."""
    length_retry_used = False
    data, problems = None, []
    for attempt in range(LANGUAGE_RETRIES + 1):
        result = ask(client, system=system, prompt=prompt, schema=schema, effort=effort, max_tokens=16000)
        usage.add(result.usage)
        data = result.data
        language_ok, length_ok = _check(data["description"], data["seo_description"], language, lo, hi)
        if language_ok and length_ok:
            return data, []
        if language_ok and not length_ok:
            if length_retry_used:
                break
            length_retry_used = True
            continue
        if attempt == LANGUAGE_RETRIES:
            problems.append(
                ("blocked", "language_body", f"След {LANGUAGE_RETRIES + 1} опита текстът не е на „{language}“.")
            )
            return data, problems
    n, s = len(data["description"]), len(data["seo_description"])
    if not lo <= n <= hi:
        problems.append(("warning", "description_length", f"Описанието е {n} знака; групата иска {lo}–{hi}."))
    if s > SEO_MAX:
        problems.append(("warning", "seo_length", f"SEO описанието е {s} знака; максимумът е {SEO_MAX}."))
    return data, problems


TEXT_PROPS = {"description": {"type": "string"}, "seo_description": {"type": "string"}}


def english_master(client, facts: dict, group: Group) -> Text:
    lo, hi = group.spec.description.length
    schema = {"type": "object", "properties": TEXT_PROPS, "required": list(TEXT_PROPS), "additionalProperties": False}
    usage = Usage()
    prompt = "Facts (verified by research):\n" + "\n".join(f"- {k}: {v}" for k, v in facts.items() if v)
    data, problems = _attempts(
        client,
        system=MASTER_SYSTEM.format(guide=group.description_guide, lo=lo, hi=hi),
        prompt=prompt,
        schema=schema,
        effort="medium",
        language="en",
        lo=lo,
        hi=hi,
        usage=usage,
    )
    notes = {k: list(facts.get(k) or []) for k in NOTE_KEYS}
    return Text("en", data["description"], data["seo_description"], notes, problems=problems, usage=usage)


def localize(client, master: Text, language: str, group: Group, tester: bool) -> Text:
    sentence = group.spec.tester_sentence.get(language) if tester else None
    if language == "en":
        return Text(
            "en",
            master.description,
            master.seo_description,
            master.notes,
            tester_sentence=sentence,
            problems=list(master.problems),
        )
    glossary = load_glossary(language)
    unknown = sorted({t for terms in master.notes.values() for t in terms if t.lower() not in glossary})
    need_sentence = tester and not sentence
    lo, hi = group.spec.description.length
    props = {
        **TEXT_PROPS,
        "notes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"en": {"type": "string"}, "local": {"type": "string"}},
                "required": ["en", "local"],
                "additionalProperties": False,
            },
        },
        "tester_sentence": {"type": "string"},
    }
    schema = {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}
    prompt = (
        f"Description:\n{master.description}\n\nSEO description:\n{master.seo_description}\n\n"
        f"Notes to translate: {', '.join(unknown) if unknown else '(none)'}\n"
        + (
            f"Also translate this sentence as tester_sentence: {group.spec.tester_sentence['en']}\n"
            if need_sentence
            else "tester_sentence: return an empty string.\n"
        )
    )
    usage = Usage()
    name = LANGUAGE_NAMES.get(language, language)
    data, problems = _attempts(
        client,
        system=LOCAL_SYSTEM.format(language_name=name, lo=lo, hi=hi),
        prompt=prompt,
        schema=schema,
        effort="low",
        language=language,
        lo=lo,
        hi=hi,
        usage=usage,
    )
    new_terms = {n["en"].lower(): n["local"].lower() for n in data["notes"] if n["en"].lower() in unknown}
    missing = [t for t in unknown if t not in new_terms]
    if missing:
        problems.append(("blocked", "note_translation", f"Липсва превод на нотите: {', '.join(missing)}."))
    notes = {
        k: [glossary.get(t.lower()) or new_terms.get(t.lower(), t) for t in terms] for k, terms in master.notes.items()
    }
    return Text(
        language,
        data["description"],
        data["seo_description"],
        notes,
        new_terms=new_terms,
        tester_sentence=sentence or (data["tester_sentence"] or None if need_sentence else None),
        tester_sentence_is_new=need_sentence,
        problems=problems,
        usage=usage,
    )


def text_fields(text: Text, master: Text, group: Group) -> dict[str, Field]:
    """Fields for one store from its language's text. Generated prose is suggested until the group opts in."""
    status = "ok" if group.spec.auto_accept_generated else "suggested"
    body = text.description
    body_en = master.description
    if text.tester_sentence:
        body = f"{body} {text.tester_sentence}"
        body_en = f"{body_en} {group.spec.tester_sentence.get('en', '')}".strip()
    fields = {
        "body_html": Field(
            key="body_html", value=f"<p>{body}</p>", origin="ai_generated", status=status, value_en=f"<p>{body_en}</p>"
        ),
        "seo_description": Field(
            key="seo_description",
            value=text.seo_description,
            origin="ai_generated",
            status=status,
            value_en=master.seo_description,
        ),
    }
    if status == "suggested":
        fields["body_html"].message = "Генериран текст. Прегледай и приеми."
    if text.tester_sentence_is_new:
        fields["body_html"].flag(
            "suggested",
            f"Изречението за тестер на „{text.language}“ е нов превод: „{text.tester_sentence}“. Приеми го веднъж.",
            "tester_sentence_new",
        )
    for status_, rule, message in text.problems:
        target = fields["seo_description"] if rule == "seo_length" else fields["body_html"]
        target.flag(status_, message, rule)

    for key in NOTE_KEYS:
        en_terms, local_terms = master.notes.get(key, []), text.notes.get(key, [])
        new = [f"{e} → {text.new_terms[e.lower()]}" for e in en_terms if e.lower() in text.new_terms]
        f = Field(
            key=key,
            value=", ".join(local_terms),
            origin="ai_generated" if new else "vocab",
            status="suggested" if new else "ok",
            value_en=", ".join(en_terms),
        )
        if new:
            f.message = "Нови преводи (влизат в глосара след приемане): " + "; ".join(new)
        fields[key] = f
    return fields


def generate_all(client, facts: dict, group: Group, languages: list[str], tester: bool) -> tuple[Text, dict[str, Text]]:
    """English master once, then each needed language once."""
    master = english_master(client, facts, group)
    out = {}
    for language in dict.fromkeys(languages):
        try:
            out[language] = localize(client, master, language, group, tester)
        except AIError as exc:
            out[language] = Text(language, "", "", {}, problems=[("blocked", "generation_failed", str(exc))])
    return master, out
