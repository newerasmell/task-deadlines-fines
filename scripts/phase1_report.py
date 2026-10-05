#!/usr/bin/env python
"""Phase 1 evidence (SPEC §9.1): detect_store vs the group-1 seed, and the audit of both exports.

python scripts/phase1_report.py            # writes docs/phase1-report.md
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pipeline.config import load_group  # noqa: E402
from pipeline.detect import detect_profile  # noqa: E402
from pipeline.export import load_export  # noqa: E402
from pipeline.seed_check import compare  # noqa: E402
from pipeline.validate import audit  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"
STORES = {"premierparfums": "parfemija", "parfemija": "premierparfums"}
STATUS = {
    "blocked": "блокирани",
    "warning": "предупреждения",
    "suggested": "за преглед",
    "fixed": "поправени",
    "ok": "ok",
}


def short(value, limit=70) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    text = text.replace("|", "\\|").replace("\n", " ")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def pct(rate) -> str:
    return "—" if rate is None else f"{rate:.0%}"


def main() -> int:
    group = load_group("group-1")
    exports = {k: load_export(FIXTURES / f"{k}_export.csv") for k in STORES}
    lines = [
        "# Фаза 1: отчет",
        "",
        "Генерирано от `python scripts/phase1_report.py` върху `tests/fixtures`. Не се редактира на ръка.",
        "",
    ]
    for store, ref in STORES.items():
        profile = detect_profile(exports[store], store, group=group, reference=exports[ref])
        out = ROOT / "output"
        out.mkdir(exist_ok=True)
        (out / f"profile-{store}.json").write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")
        checks = compare(profile, group)
        agree = [c for c in checks if c.agrees]
        differ = [c for c in checks if not c.agrees]
        label = group.store(store).label
        lines += [
            f"## {label}: профил срещу seed-а",
            "",
            f"{profile['products']} продукта. {len(agree)} от {len(checks)} проверки съвпадат с "
            "`config/groups/group-1`.",
            "",
            "### Разминавания",
            "",
            "| Елемент | В конфигурацията | В експорта | Покритие | Бележка |",
            "|---|---|---|---|---|",
        ]
        for c in differ:
            detected = short(c.detected, 600 if "нови канонични" in c.item else 70)
            lines.append(f"| {short(c.item, 40)} | {short(c.config)} | {detected} | {pct(c.rate)} | {c.note} |")
        lines += [
            "",
            "<details><summary>Съвпадения</summary>",
            "",
            "| Елемент | Стойност | Покритие |",
            "|---|---|---|",
        ]
        for c in agree:
            lines.append(f"| {short(c.item, 40)} | {short(c.detected)} | {pct(c.rate)} |")
        lines += ["", "</details>", ""]

        report = audit(exports[store], group, store)
        s = report.summary()
        lines += [
            f"## {label}: одит (validate.py --audit)",
            "",
            "Продукти по най-лошия статус: "
            + " · ".join(f"{n} {STATUS[k]}" for k, n in s["products_by_status"].items() if n)
            + ".",
            "",
            "| Правило | Статус | Брой | Пример |",
            "|---|---|---|---|",
        ]
        for rule, info in s["rules"].items():
            ex = info["examples"][0]
            lines.append(
                f"| `{rule}` | {info['status']} | {info['count']} | "
                f"{short(ex['title'], 40)}: {short(ex['message'], 90)} |"
            )
        lines.append("")

    path = ROOT / "docs" / "phase1-report.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    print(f"Записано: {path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
