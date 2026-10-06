"""Read a batch input file (input/products_template.csv). Row problems are kept, not fatal (SPEC §1, §7)."""

import csv
import io
import re
from dataclasses import dataclass, field
from pathlib import Path

from pipeline import ean
from pipeline.config import INPUT_BASE_COLUMNS, Group
from pipeline.tiers import tier

TRUE = {"1", "true", "yes", "y", "да", "x", "tester"}
FALSE = {"", "0", "false", "no", "n", "не"}


class InputError(Exception):
    """The file cannot be used at all (wrong columns, empty)."""


@dataclass
class InputRow:
    line: int
    name: str
    ml: float | None
    tester: bool
    ean: str
    prices: dict[str, str | None]
    notes: str = ""
    tier: str | None = None  # economy / deep from the `research` column; None = the batch's choice
    problems: list[str] = field(default_factory=list)

    @property
    def label(self) -> str:
        return f"ред {self.line}: {self.name or '(без име)'}"


def read_input(path: str | Path, group: Group, stores: list[str] | None = None) -> list[InputRow]:
    with Path(path).open(encoding="utf-8-sig", newline="") as fh:
        return _read(fh, group, stores)


def read_input_text(text: str, group: Group, stores: list[str] | None = None) -> list[InputRow]:
    """The same input as text: an uploaded CSV, or rows pasted from Excel (tab-separated) in the app."""
    text = text.lstrip("\ufeff")
    first = text.split("\n", 1)[0]
    delimiter = "\t" if first.count("\t") > first.count(",") else ("," if "," in first else ";")
    return _read(io.StringIO(text), group, stores, delimiter)


NAME_ML = re.compile(r"(\d+(?:[.,]\d+)?)\s*ml\b", re.IGNORECASE)
NAME_TESTER = re.compile(r"\b(tester|тестер)\b", re.IGNORECASE)
NAME_EAN = re.compile(r"(?<!\d)(\d{13}|\d{12}|\d{8}|\d{14})(?!\d)")


def read_names_text(text: str, group: Group, stores: list[str] | None = None) -> list[InputRow]:
    """One product per line, only its name ("Dior Sauvage EDT 100 ml TESTER"); the volume, the tester flag and
    an EAN, when the line has them, are read from it. Research finds the rest; an EAN only as a suggestion from
    the sources, prices are entered by a person in the review (CLAUDE.md #6)."""
    stores = stores or list(group.stores)
    for key in stores:
        group.store(key)
    rows = []
    for line, raw in enumerate(text.lstrip("\ufeff").splitlines(), 1):
        if not raw.strip():
            continue
        code = NAME_EAN.search(raw)
        rest = NAME_EAN.sub(" ", raw) if code else raw
        ml_match = NAME_ML.search(rest)
        tester = bool(NAME_TESTER.search(rest))
        name = " ".join(NAME_TESTER.sub(" ", NAME_ML.sub(" ", rest)).split()).strip(" ,;-")
        problems = []
        ml = None
        if ml_match:
            ml = float(ml_match.group(1).replace(",", "."))
        else:
            problems.append("Липсва обем: добави го в реда, напр. „100 ml“.")
        if not name:
            problems.append("Липсва име на продукта.")
        rows.append(
            InputRow(
                line=line,
                name=name,
                ml=ml,
                tester=tester,
                ean=ean.clean(code.group(1)) if code else "",
                prices=dict.fromkeys(stores),
                problems=problems,
            )
        )
    if not rows:
        raise InputError("Няма нито един продукт. Напиши по един на ред.")
    return rows


def _read(fh, group: Group, stores: list[str] | None, delimiter: str = ",") -> list[InputRow]:
    stores = stores or list(group.stores)
    for key in stores:
        group.store(key)  # unknown store -> clear error
    reader = csv.DictReader(fh, delimiter=delimiter)
    columns = [c.strip() for c in reader.fieldnames or []]
    needed = [*INPUT_BASE_COLUMNS, *(f"price_{k}" for k in stores)]
    missing = [c for c in needed if c not in columns]
    if missing:
        raise InputError(f"Във файла липсват колони: {', '.join(missing)}. Изтегли шаблона и попълни него.")
    rows = [_row(i, {k.strip(): (v or "").strip() for k, v in r.items() if k}, stores) for i, r in enumerate(reader, 2)]
    rows = [r for r in rows if r.name or r.ean]
    if not rows:
        raise InputError("Файлът няма нито един продукт.")
    return rows


def _row(line: int, r: dict[str, str], stores: list[str]) -> InputRow:
    problems = []
    try:
        ml = float(r["ml"].replace(",", ".").lower().replace("ml", "").strip())
        if ml <= 0:
            raise ValueError
    except ValueError:
        ml = None
        problems.append(f"Обемът „{r['ml']}“ не е число в ml.")
    flag = r["tester"].lower()
    if flag not in TRUE | FALSE:
        problems.append(f"Колоната tester е „{r['tester']}“; очаква се да/не.")
    if not r["name"]:
        problems.append("Липсва име на продукта.")
    prices = {k: (r.get(f"price_{k}") or None) for k in stores}
    tier_name = None
    if r.get("research"):
        try:
            tier_name = tier(r["research"]).name
        except KeyError as exc:
            problems.append(str(exc).strip('"'))
    return InputRow(
        line=line,
        name=r["name"],
        ml=ml,
        tester=flag in TRUE,
        ean=ean.clean(r["ean"]),
        prices=prices,
        notes=r.get("notes", ""),
        tier=tier_name,
        problems=problems,
    )
