"""Read a batch input file (input/products_template.csv). Row problems are kept, not fatal (SPEC §1, §7)."""

import csv
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
    stores = stores or list(group.stores)
    for key in stores:
        group.store(key)  # unknown store -> clear error
    with Path(path).open(encoding="utf-8-sig", newline="") as fh:
        reader = csv.DictReader(fh)
        columns = [c.strip() for c in reader.fieldnames or []]
        needed = [*INPUT_BASE_COLUMNS, *(f"price_{k}" for k in stores)]
        missing = [c for c in needed if c not in columns]
        if missing:
            raise InputError(f"Във файла липсват колони: {', '.join(missing)}. Шаблон: input/products_template.csv")
        rows = [
            _row(i, {k.strip(): (v or "").strip() for k, v in r.items() if k}, stores) for i, r in enumerate(reader, 2)
        ]
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
