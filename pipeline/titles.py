"""Parse product titles into brand / name / concentration / ml / tester, and render the title formula."""

import re
from dataclasses import dataclass

from pipeline.text import collapse_spaces, format_ml

# Longest first so "Extrait de Parfum" wins over "Parfum". Domain vocabulary, not store-specific.
CONCENTRATIONS = [
    "Extrait de Parfum",
    "Eau de Parfum",
    "Eau de Toilette",
    "Eau de Cologne",
    "Eau Fraiche",
    "Extrait",
    "Parfum",
    "Elixir",
    "Cologne",
    "EDP",
    "EDT",
    "EDC",
]
ABBREVIATIONS = {"EDP": "Eau de Parfum", "EDT": "Eau de Toilette", "EDC": "Eau de Cologne"}

ML_AT_END = re.compile(r"\s*(\d+(?:[.,]\d+)?)(\s?)ml$", re.IGNORECASE)
TESTER_AT_END = re.compile(r"\s+(tester)$", re.IGNORECASE)
CONC_AT_END = re.compile(r"\s+(" + "|".join(re.escape(c) for c in CONCENTRATIONS) + r")$", re.IGNORECASE)


@dataclass
class ParsedTitle:
    title: str
    brand: str | None = None  # vendor, when the title starts with it
    name: str = ""
    concentration: str | None = None  # as written in the title
    ml: str | None = None
    ml_spaced: bool = True
    tester: str | None = None  # the marker exactly as written ("TESTER")

    @property
    def shape(self) -> str:
        """The title formula this title follows, in group.yaml syntax, without the optional tester part."""
        if self.ml is None:
            return "(не следва шаблон с ml)"
        parts = []
        if self.brand:
            parts.append("{brand}")
        if self.name:
            parts.append("{name}")
        if self.concentration:
            parts.append("{concentration_short}")
        parts.append("{ml} ml" if self.ml_spaced else "{ml}ml")
        return " ".join(parts)  # the tester marker is optional and tracked separately


def parse_title(title: str, vendor: str = "") -> ParsedTitle:
    t = collapse_spaces(title)
    p = ParsedTitle(title=t)
    if m := TESTER_AT_END.search(t):
        p.tester, t = m.group(1), t[: m.start()]
    if m := ML_AT_END.search(t):
        p.ml, p.ml_spaced, t = m.group(1).replace(",", "."), bool(m.group(2)), t[: m.start()]
    else:
        p.name = t
        return p
    if m := CONC_AT_END.search(t):
        p.concentration, t = m.group(1), t[: m.start()]
    vendor = collapse_spaces(vendor)
    if vendor and t.casefold().startswith(vendor.casefold() + " "):
        p.brand, t = vendor, t[len(vendor) + 1 :]
    p.name = t.strip()
    return p


def short_concentration(concentration: str | None, mapping: dict[str, str]) -> str | None:
    """'Eau de Parfum' -> 'EDP' per group.yaml; anything not in the mapping stays as written."""
    if not concentration:
        return None
    for full, short in mapping.items():
        if concentration.casefold() in (full.casefold(), short.casefold()):
            return short
    return concentration


TOKEN = re.compile(r"\{(\w+)(?::\s*'([^']*)')?\}")


def render(formula: str, values: dict) -> str:
    """Render a group.yaml formula. {x} inserts a value; {flag: 'text'} inserts text when flag is truthy."""

    def sub(m: re.Match) -> str:
        key, literal = m.group(1), m.group(2)
        if literal is not None:
            return literal if values.get(key) else ""
        value = values.get(key)
        if key == "ml" and value is not None:
            return format_ml(value)
        return "" if value is None else str(value)

    return collapse_spaces(TOKEN.sub(sub, formula))
