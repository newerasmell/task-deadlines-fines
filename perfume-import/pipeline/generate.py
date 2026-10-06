"""Generated prose (SPEC §5): an English master per product, then one localization per store language.

English is the master; every localized field keeps its English reference in `value_en` (CLAUDE.md #5).
Notes are translated by the glossary first; only unknown terms go to the model and come back as suggestions.
The tester sentence is fixed text from group.yaml, appended by code, never written by the model.
After each attempt the SPEC §7 checks run: wrong language -> retry up to 2 times then blocked;
length out of range -> one retry then warning.
"""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from pipeline import lang
from pipeline.ai import AIError, Usage, ask, ask_batch, params
from pipeline.config import Group, load_glossary
from pipeline.fields import Field
from pipeline.text import strip_html
from pipeline.tiers import DEFAULT_TIER, TIERS, Tier

NOTE_KEYS = ("top_note", "middle_note", "base_note")
SEO_MAX = 160
LANGUAGE_RETRIES = 2
MAX_PARALLEL = 10  # interactive text calls at a time

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

STORE_SYSTEM = """You write the product description for the online perfume shop "{label}", in {language_name}.
You get an English reference description and the verified facts. Write this shop's own text from them:
- Follow the shop's style shown in its existing descriptions below: structure ({shape}), paragraphing, tone,
  sentence length, how it opens and how it presents the notes. Never copy their wording, and never take facts
  from them: they are about other perfumes.
- Do not translate the reference sentence by sentence: rephrase freely and order the information your own way,
  so the text reads differently from any other shop selling the same perfume. Keep every fact; add none.
- Keep brand and fragrance names exactly as written. {lo}-{hi} characters of visible text.
- description: HTML using only <p>, <br>, <strong>, <em>, <ul>, <li>, in the shop's structure.
- seo_description: plain text, at most 160 characters, also in the shop's own words.
- Translate each listed perfume note as a perfumer would name it in {language_name}, lowercase.
Do not mention that the product is a tester and do not mention price.

The shop's existing descriptions (style reference only):
{examples}"""

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
class StoreStyle:
    """How one store writes its descriptions, learned from its catalog (the accepted profile): two competing
    stores in one language get two different texts from the same facts."""

    key: str
    label: str
    language: str
    lo: int
    hi: int
    shape: str  # e.g. "3 × <p>" or "1 × <p> + <strong>"
    examples: list[str]  # a few of its own descriptions (HTML), style reference only


def store_style(store, profile: dict | None, group: Group) -> StoreStyle | None:
    """None without an accepted profile with example descriptions: the store then gets its language's text."""
    if not profile:
        return None
    items = profile.get("items", profile)

    def value(key: str):
        it = items.get(key) or {}
        return None if it.get("status") == "rejected" else it.get("value")

    examples = [e["body_html"][:1500] for e in (value("description_examples") or []) if e.get("body_html")][:3]
    if not examples:
        return None
    lo, hi = group.spec.description.length
    learned = value("description_length")
    if isinstance(learned, list | tuple) and len(learned) == 2 and 50 <= int(learned[0]) < int(learned[1]):
        lo, hi = int(learned[0]), int(learned[1])
    return StoreStyle(store.key, store.label, store.language, lo, hi, value("description_html") or "1 × <p>", examples)


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
    html: bool = False  # the description is the store's own HTML (StoreStyle), not plain text to wrap in <p>


def _check(text: str, seo: str, language: str, lo: int, hi: int) -> tuple[bool, bool]:
    """-> (language ok, length ok). Lengths count visible text."""
    text = strip_html(text)
    found = lang.detect(text)
    language_ok = found in (None, language)
    length_ok = lo <= len(text) <= hi and len(seo) <= SEO_MAX
    return language_ok, length_ok


TEXT_PROPS = {"description": {"type": "string"}, "seo_description": {"type": "string"}}


@dataclass
class Task:
    """One text request (a master or a translation) and its SPEC §7 retry state."""

    id: str
    language: str
    request: dict  # keyword arguments for ai.ask / ai.params
    lo: int
    hi: int
    batch: bool = False  # through the Message Batches API (economy tier)
    attempts: int = 0
    length_retry_used: bool = False
    data: dict | None = None
    problems: list[tuple[str, str, str]] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)


def _execute(client, tasks: list[Task], batch: bool | None) -> dict:
    """batch=None: each task decides (its tier); True/False forces every task one way."""
    batched = [t for t in tasks if (t.batch if batch is None else batch)]
    out = ask_batch(client, {t.id: params(**t.request) for t in batched}) if batched else {}

    def one(t: Task):
        try:
            return ask(client, **t.request)
        except AIError as exc:
            return exc

    # Interactive texts run side by side: twenty products take about as long as one.
    direct = [t for t in tasks if t not in batched]
    if direct:
        with ThreadPoolExecutor(max_workers=min(len(direct), MAX_PARALLEL)) as pool:
            out.update(zip((t.id for t in direct), pool.map(one, direct), strict=True))
    return out


def run_tasks(client, tasks: list[Task], batch: bool | None = False) -> None:
    """Send every pending task (one batch per round when batch=True), check language and length, retry:
    wrong language up to LANGUAGE_RETRIES more times then blocked; length out of range once then warning."""
    pending = list(tasks)
    while pending:
        results = _execute(client, pending, batch)
        retry = []
        for t in pending:
            result = results[t.id]
            t.attempts += 1
            if isinstance(result, AIError):
                t.problems = [("blocked", "generation_failed", str(result))]
                continue
            t.usage.add(result.usage)
            t.data = result.data
            language_ok, length_ok = _check(t.data["description"], t.data["seo_description"], t.language, t.lo, t.hi)
            if language_ok and length_ok:
                t.problems = []
            elif not language_ok:
                if t.attempts <= LANGUAGE_RETRIES:
                    retry.append(t)
                else:
                    t.problems = [
                        ("blocked", "language_body", f"След {t.attempts} опита текстът не е на „{t.language}“.")
                    ]
            elif not t.length_retry_used and t.attempts <= LANGUAGE_RETRIES:
                t.length_retry_used = True
                retry.append(t)
            else:
                t.problems = _length_problems(t)
        pending = retry


def _length_problems(t: Task) -> list[tuple[str, str, str]]:
    problems = []
    n, s = len(t.data["description"]), len(t.data["seo_description"])
    if not t.lo <= n <= t.hi:
        problems.append(("warning", "description_length", f"Описанието е {n} знака; групата иска {t.lo}–{t.hi}."))
    if s > SEO_MAX:
        problems.append(("warning", "seo_length", f"SEO описанието е {s} знака; максимумът е {SEO_MAX}."))
    return problems


def _text_request(tier: Tier, **request) -> dict:
    request["model"] = tier.text_model
    if tier.text_thinking:
        request["thinking"] = tier.text_thinking
    return request


def master_task(task_id: str, facts: dict, group: Group, tier: Tier | None = None) -> Task:
    tier = tier or TIERS[DEFAULT_TIER]
    lo, hi = group.spec.description.length
    schema = {"type": "object", "properties": TEXT_PROPS, "required": list(TEXT_PROPS), "additionalProperties": False}
    prompt = "Facts (verified by research):\n" + "\n".join(f"- {k}: {v}" for k, v in facts.items() if v)
    request = _text_request(
        tier,
        system=MASTER_SYSTEM.format(guide=group.description_guide, lo=lo, hi=hi),
        prompt=prompt,
        schema=schema,
        effort="medium",
        max_tokens=4000 if tier.text_thinking else 16000,  # room for thinking when it cannot be turned off
    )
    return Task(task_id, "en", request, lo, hi, batch=tier.text_batch)


def master_text(task: Task, facts: dict) -> Text:
    notes = {k: list(facts.get(k) or []) for k in NOTE_KEYS}
    data = task.data if task.data and not _blocked(task) else {"description": "", "seo_description": ""}
    return Text("en", data["description"], data["seo_description"], notes, problems=task.problems, usage=task.usage)


def _blocked(task: Task) -> bool:
    return any(p[0] == "blocked" and p[1] == "generation_failed" for p in task.problems)


@dataclass
class _Local:
    task: Task | None
    unknown: list[str]
    glossary: dict[str, str]
    sentence: str | None
    need_sentence: bool
    html: bool = False


def local_task(
    task_id: str, master: Text, language: str, group: Group, tester: bool, tier: Tier | None = None
) -> _Local:
    tier = tier or TIERS[DEFAULT_TIER]
    sentence = group.spec.tester_sentence.get(language) if tester else None
    if language == "en":
        return _Local(None, [], {}, sentence, False)
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
    name = LANGUAGE_NAMES.get(language, language)
    request = _text_request(
        tier,
        system=LOCAL_SYSTEM.format(language_name=name, lo=lo, hi=hi),
        prompt=prompt,
        schema=schema,
        effort="low",
        max_tokens=4000 if tier.text_thinking else 16000,
    )
    task = Task(task_id, language, request, lo, hi, batch=tier.text_batch)
    return _Local(task, unknown, glossary, sentence, need_sentence)


def store_task(
    task_id: str, master: Text, style: StoreStyle, group: Group, tester: bool, tier: Tier | None = None
) -> _Local:
    """The store's own text in its language and style, from the English master (also for English stores)."""
    tier = tier or TIERS[DEFAULT_TIER]
    language = style.language
    sentence = group.spec.tester_sentence.get(language) if tester else None
    glossary = load_glossary(language) if language != "en" else {}
    unknown = (
        sorted({t for terms in master.notes.values() for t in terms if t.lower() not in glossary})
        if language != "en"
        else []
    )
    need_sentence = tester and not sentence
    note_item = {
        "type": "object",
        "properties": {"en": {"type": "string"}, "local": {"type": "string"}},
        "required": ["en", "local"],
        "additionalProperties": False,
    }
    props = {**TEXT_PROPS, "notes": {"type": "array", "items": note_item}, "tester_sentence": {"type": "string"}}
    schema = {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}
    prompt = (
        f"English reference description:\n{master.description}\n\n"
        f"English SEO description:\n{master.seo_description}\n\n"
        f"Notes to translate: {', '.join(unknown) if unknown else '(none)'}\n"
        + (
            f"Also translate this sentence as tester_sentence: {group.spec.tester_sentence['en']}\n"
            if need_sentence
            else "tester_sentence: return an empty string.\n"
        )
    )
    examples = "\n\n".join(f"--- example {i + 1} ---\n{e}" for i, e in enumerate(style.examples))
    system = STORE_SYSTEM.format(
        label=style.label,
        language_name=LANGUAGE_NAMES.get(language, language),
        shape=style.shape,
        lo=style.lo,
        hi=style.hi,
        examples=examples,
    )
    request = _text_request(
        tier,
        system=system,
        prompt=prompt,
        schema=schema,
        effort="low",
        max_tokens=4000 if tier.text_thinking else 16000,
    )
    task = Task(task_id, language, request, style.lo, style.hi, batch=tier.text_batch)
    return _Local(task, unknown, glossary, sentence, need_sentence, html=True)


def local_text(local: _Local, master: Text, language: str) -> Text:
    if local.task is None:  # English store: the master is the text
        return Text(
            "en",
            master.description,
            master.seo_description,
            master.notes,
            tester_sentence=local.sentence,
            problems=list(master.problems),
        )
    task = local.task
    if task.data is None or _blocked(task):
        return Text(language, "", "", {}, problems=task.problems, usage=task.usage, html=local.html)
    data, problems = task.data, list(task.problems)
    new_terms = {n["en"].lower(): n["local"].lower() for n in data["notes"] if n["en"].lower() in local.unknown}
    missing = [t for t in local.unknown if t not in new_terms]
    if missing:
        problems.append(("blocked", "note_translation", f"Липсва превод на нотите: {', '.join(missing)}."))
    notes = {
        k: [local.glossary.get(t.lower()) or new_terms.get(t.lower(), t) for t in terms]
        for k, terms in master.notes.items()
    }
    return Text(
        language,
        data["description"],
        data["seo_description"],
        notes,
        new_terms=new_terms,
        tester_sentence=local.sentence or ((data["tester_sentence"] or None) if local.need_sentence else None),
        tester_sentence_is_new=local.need_sentence,
        problems=problems,
        usage=task.usage,
        html=local.html,
    )


def generate_texts(
    client,
    items: list[tuple],
    group: Group,
    languages: list[str],
    batch: bool | None = None,
    styles: list[StoreStyle] | None = None,
) -> list[tuple[Text, dict[str, Text]]]:
    """Texts for many products: all English masters in one round, then every product x language in the next.
    items = [(facts, tester), ...] or [(facts, tester, tier), ...]. With batch=None each product's tier decides
    (economy -> one Message Batch per round at half price, deep -> interactive); True/False forces it."""
    languages = list(dict.fromkeys(languages))
    items = [(it[0], it[1], it[2] if len(it) > 2 and it[2] else TIERS[DEFAULT_TIER]) for it in items]
    masters = [master_task(f"m{i}", facts, group, tier) for i, (facts, _, tier) in enumerate(items)]
    run_tasks(client, masters, batch)
    master_texts = [master_text(t, facts) for t, (facts, _, _) in zip(masters, items, strict=True)]

    locals_: dict[tuple[int, str], _Local] = {}
    for i, (master, (_, tester, tier)) in enumerate(zip(master_texts, items, strict=True)):
        if not master.description:
            continue
        for language in languages:
            locals_[(i, language)] = local_task(f"t{i}-{language}", master, language, group, tester, tier)
        for style in styles or []:
            locals_[(i, style_key(style))] = store_task(f"t{i}-s-{style.key}", master, style, group, tester, tier)
    run_tasks(client, [lo.task for lo in locals_.values() if lo.task], batch)

    targets = [*languages, *(style_key(st) for st in styles or [])]
    language_of = {style_key(st): st.language for st in styles or []}
    out = []
    for i, master in enumerate(master_texts):
        texts = {}
        for language in targets:
            code = language_of.get(language, language)
            if (i, language) in locals_:
                texts[language] = local_text(locals_[(i, language)], master, code)
            else:
                texts[language] = Text(
                    code, "", "", {}, problems=[("blocked", "generation_failed", "Няма английски оригинал.")]
                )
        out.append((master, texts))
    return out


def style_key(style: StoreStyle) -> str:
    """Key of a store's own text in generate_texts' result (languages are keyed by their code)."""
    return f"store:{style.key}"


def english_master(client, facts: dict, group: Group) -> Text:
    task = master_task("m0", facts, group)
    run_tasks(client, [task])
    return master_text(task, facts)


def localize(client, master: Text, language: str, group: Group, tester: bool) -> Text:
    local = local_task("t0", master, language, group, tester)
    if local.task:
        run_tasks(client, [local.task])
    return local_text(local, master, language)


def _with_sentence(html: str, sentence: str) -> str:
    """The tester sentence closes the last paragraph of the store's HTML (or follows it)."""
    end = html.rfind("</p>")
    if end == -1:
        return f"{html} {sentence}".strip()
    return f"{html[:end].rstrip()} {sentence}{html[end:]}"


def text_fields(text: Text, master: Text, group: Group) -> dict[str, Field]:
    """Fields for one store from its language's text. Generated prose is suggested until the group opts in."""
    status = "ok" if group.spec.auto_accept_generated else "suggested"
    body = text.description
    body_en = master.description
    if text.tester_sentence:
        body = _with_sentence(body, text.tester_sentence) if text.html else f"{body} {text.tester_sentence}"
        body_en = f"{body_en} {group.spec.tester_sentence.get('en', '')}".strip()
    fields = {
        "body_html": Field(
            key="body_html",
            value=body if text.html else f"<p>{body}</p>",
            origin="ai_generated",
            status=status,
            value_en=f"<p>{body_en}</p>",
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
        elif not en_terms:  # research found none: never shown as done
            f.flag(
                "warning",
                "Проучването не намери нотки. Попълни ги или проучи продукта задълбочено.",
                "notes_missing",
            )
        fields[key] = f
    return fields


def generate_all(client, facts: dict, group: Group, languages: list[str], tester: bool) -> tuple[Text, dict[str, Text]]:
    """One product, interactive calls: English master once, then each needed language once."""
    return generate_texts(client, [(facts, tester)], group, languages, batch=False)[0]
