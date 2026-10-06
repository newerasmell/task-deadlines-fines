"""AI proposals for the two decisions left open in phase 1 (docs/decisions.md #5 and #7).

#5 vocab: a value outside vocab.yaml ("Ανατολίτικη λουλουδάτη") gets a proposed canonical, picked only from the
   vocab (enum) or NONE. It is stored as suggested; a person accepts it once and validate then fixes it.
#7 glossary: a local note pair from two stores (βανίλια ↔ vanilija) gets its English canonical term. A pair is
   accepted into the glossary only when the model confirms both translations and the pair was consistent in the
   exports; everything else goes to pending for a person to check.
"""

from dataclasses import dataclass, field

from pipeline.ai import Usage, ask

CHUNK = 80
NONE = "NONE"

VOCAB_SYSTEM = """You map shop catalog values to a fixed English vocabulary for perfumes.
Each value may be in any language (Greek, Croatian, Polish, ...) or a misspelling. For each value pick the
single closest allowed value, or NONE if no allowed value fits. A compound family ("Woody Spicy") maps to the
closest allowed value only if it keeps the main character. Give a confidence from 0 to 1 and a short reason."""

GLOSSARY_SYSTEM = """You are a perfumer building a glossary of perfume note names.
For each pair of local note names (the same note in two languages, taken from two shops) give the canonical
English note name as perfumers write it, lowercase, and say whether each local name is a correct translation."""


@dataclass
class Suggestions:
    items: list[dict]
    usage: Usage = field(default_factory=Usage)


def _chunks(items: list, size: int = CHUNK):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def suggest_vocab(client, field_key: str, values: dict[str, int], canonicals: list[str]) -> Suggestions:
    schema = {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "variant": {"type": "string"},
                        "canonical": {"type": "string", "enum": [*canonicals, NONE]},
                        "confidence": {"type": "number"},
                        "reason": {"type": "string"},
                    },
                    "required": ["variant", "canonical", "confidence", "reason"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["items"],
        "additionalProperties": False,
    }
    out = Suggestions(items=[])
    asked = sorted(values, key=lambda v: -values[v])
    for chunk in _chunks(asked):
        prompt = (
            f"Field: {field_key}\nAllowed values: {', '.join(canonicals)}\nValues to map (one per line):\n"
            + "\n".join(chunk)
        )
        result = ask(client, system=VOCAB_SYSTEM, prompt=prompt, schema=schema, effort="medium")
        out.usage.add(result.usage)
        wanted = set(chunk)
        for item in result.data["items"]:
            if item["variant"] in wanted:  # ignore anything the model invented
                wanted.discard(item["variant"])
                out.items.append(
                    {
                        **item,
                        "canonical": None if item["canonical"] == NONE else item["canonical"],
                        "confidence": max(0.0, min(1.0, item["confidence"])),
                        "count": values[item["variant"]],
                    }
                )
    return out


def build_glossary(client, pairs: dict[str, dict], lang_a: str, lang_b: str) -> tuple[dict, dict, dict, Usage]:
    """-> (accepted lang_a, accepted lang_b, pending, usage). Glossaries are english -> local, lowercase."""
    schema = {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "a": {"type": "string"},
                        "b": {"type": "string"},
                        "en": {"type": "string"},
                        "a_ok": {"type": "boolean"},
                        "b_ok": {"type": "boolean"},
                    },
                    "required": ["a", "b", "en", "a_ok", "b_ok"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["items"],
        "additionalProperties": False,
    }
    usage = Usage()
    accepted_a, accepted_b, pending = {}, {}, {}
    terms = sorted(pairs)
    for chunk in _chunks(terms):
        lines = [f"{a} | {pairs[a]['translation']}" for a in chunk]
        prompt = f"Pairs ({lang_a} | {lang_b}):\n" + "\n".join(lines)
        result = ask(client, system=GLOSSARY_SYSTEM, prompt=prompt, schema=schema, effort="low")
        usage.add(result.usage)
        for item in result.data["items"]:
            a = item["a"].strip().lower()
            if a not in pairs:
                continue
            b, en = pairs[a]["translation"], item["en"].strip().lower()
            consistent = pairs[a].get("consistency", 1.0) >= 0.9
            if item["a_ok"] and item["b_ok"] and consistent and en:
                if en in accepted_a and accepted_a[en] != a:
                    pending[en] = {
                        lang_a: [accepted_a.pop(en), a],
                        lang_b: [accepted_b.pop(en), b],
                        "why": "две двойки за един термин",
                    }
                    continue
                if en not in pending:
                    accepted_a[en], accepted_b[en] = a, b
            else:
                why = []
                if not item["a_ok"]:
                    why.append(f"{lang_a} превод съмнителен")
                if not item["b_ok"]:
                    why.append(f"{lang_b} превод съмнителен")
                if not consistent:
                    why.append("двойката не е постоянна в експортите")
                pending[en or a] = {lang_a: a, lang_b: b, "why": ", ".join(why)}
    return accepted_a, accepted_b, pending, usage
