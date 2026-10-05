"""Generated prose (SPEC §5): an English master per product, then one localization per store language.

English is the master; every localized field keeps its English reference in `value_en` (CLAUDE.md #5).
Notes are translated by the glossary first; only unknown terms go to the model and come back as suggestions.
The tester sentence is fixed text from group.yaml, appended by code, never written by the model.
After each attempt the SPEC §7 checks run: wrong language -> retry up to 2 times then blocked;
length out of range -> one retry then warning.
"""

from dataclasses import dataclass, field

from pipeline import lang
from pipeline.ai import NO_THINKING, AIError, Usage, ask, ask_batch, params
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


TEXT_PROPS = {"description": {"type": "string"}, "seo_description": {"type": "string"}}


@dataclass
class Task:
    """One text request (a master or a translation) and its SPEC §7 retry state."""

    id: str
    language: str
    request: dict  # keyword arguments for ai.ask / ai.params
    lo: int
    hi: int
    attempts: int = 0
    length_retry_used: bool = False
    data: dict | None = None
    problems: list[tuple[str, str, str]] = field(default_factory=list)
    usage: Usage = field(default_factory=Usage)


def _execute(client, tasks: list[Task], batch: bool) -> dict:
    if batch:
        return ask_batch(client, {t.id: params(**t.request) for t in tasks})
    out = {}
    for t in tasks:
        try:
            out[t.id] = ask(client, **t.request)
        except AIError as exc:
            out[t.id] = exc
    return out


def run_tasks(client, tasks: list[Task], batch: bool = False) -> None:
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


def master_task(task_id: str, facts: dict, group: Group) -> Task:
    lo, hi = group.spec.description.length
    schema = {"type": "object", "properties": TEXT_PROPS, "required": list(TEXT_PROPS), "additionalProperties": False}
    prompt = "Facts (verified by research):\n" + "\n".join(f"- {k}: {v}" for k, v in facts.items() if v)
    request = {
        "system": MASTER_SYSTEM.format(guide=group.description_guide, lo=lo, hi=hi),
        "prompt": prompt,
        "schema": schema,
        "effort": "medium",
        "max_tokens": 4000,
        "thinking": NO_THINKING,
    }
    return Task(task_id, "en", request, lo, hi)


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


def local_task(task_id: str, master: Text, language: str, group: Group, tester: bool) -> _Local:
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
    request = {
        "system": LOCAL_SYSTEM.format(language_name=name, lo=lo, hi=hi),
        "prompt": prompt,
        "schema": schema,
        "effort": "low",
        "max_tokens": 4000,
        "thinking": NO_THINKING,
    }
    return _Local(Task(task_id, language, request, lo, hi), unknown, glossary, sentence, need_sentence)


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
        return Text(language, "", "", {}, problems=task.problems, usage=task.usage)
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
    )


def generate_texts(
    client, items: list[tuple[dict, bool]], group: Group, languages: list[str], batch: bool = False
) -> list[tuple[Text, dict[str, Text]]]:
    """Texts for many products: all English masters in one round, then every product x language in one round
    (each round is one Message Batch when batch=True). items = [(facts, tester), ...]."""
    languages = list(dict.fromkeys(languages))
    masters = [master_task(f"m{i}", facts, group) for i, (facts, _) in enumerate(items)]
    run_tasks(client, masters, batch)
    master_texts = [master_text(t, facts) for t, (facts, _) in zip(masters, items, strict=True)]

    locals_: dict[tuple[int, str], _Local] = {}
    for i, (master, (_, tester)) in enumerate(zip(master_texts, items, strict=True)):
        if not master.description:
            continue
        for language in languages:
            locals_[(i, language)] = local_task(f"t{i}-{language}", master, language, group, tester)
    run_tasks(client, [lo.task for lo in locals_.values() if lo.task], batch)

    out = []
    for i, master in enumerate(master_texts):
        texts = {}
        for language in languages:
            if (i, language) in locals_:
                texts[language] = local_text(locals_[(i, language)], master, language)
            else:
                texts[language] = Text(
                    language, "", "", {}, problems=[("blocked", "generation_failed", "Няма английски оригинал.")]
                )
        out.append((master, texts))
    return out


def english_master(client, facts: dict, group: Group) -> Text:
    task = master_task("m0", facts, group)
    run_tasks(client, [task])
    return master_text(task, facts)


def localize(client, master: Text, language: str, group: Group, tester: bool) -> Text:
    local = local_task("t0", master, language, group, tester)
    if local.task:
        run_tasks(client, [local.task])
    return local_text(local, master, language)


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
    """One product, interactive calls: English master once, then each needed language once."""
    return generate_texts(client, [(facts, tester)], group, languages, batch=False)[0]
