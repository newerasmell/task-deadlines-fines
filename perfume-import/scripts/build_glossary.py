#!/usr/bin/env python
"""Build the english -> local note glossaries from local pairs (docs/decisions.md #7).

    python scripts/build_glossary.py config/glossary/pairs/el-hr.yaml

Accepted terms are merged into config/glossary/<lang>.yaml (existing entries are never overwritten);
doubtful ones go to config/glossary/pending-<a>-<b>.yaml for a person to check.
"""

import argparse
import os
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.settings import ROOT  # noqa: E402


def merge(path: Path, new: dict) -> int:
    current = yaml.safe_load(path.read_text(encoding="utf-8")) if path.exists() else {}
    current = current or {}
    added = {k: v for k, v in new.items() if k not in current}
    header = "# english canonical note -> local term, lowercase. Accepted entries; edit by hand if wrong.\n"
    path.write_text(header + yaml.safe_dump({**current, **added}, allow_unicode=True, sort_keys=True), encoding="utf-8")
    return len(added)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pairs", help="config/glossary/pairs/<a>-<b>.yaml")
    args = ap.parse_args()
    lang_a, lang_b = Path(args.pairs).stem.split("-")
    pairs = yaml.safe_load(Path(args.pairs).read_text(encoding="utf-8"))
    print(f"{len(pairs)} двойки {lang_a} ↔ {lang_b}.")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("Липсва ANTHROPIC_API_KEY. Добави го като променлива на средата (не в репото) и пусни отново.")
        return 2

    from pipeline.ai import default_client
    from pipeline.suggest import build_glossary

    a, b, pending, usage = build_glossary(default_client(), pairs, lang_a, lang_b)
    folder = ROOT / "config" / "glossary"
    added_a, added_b = merge(folder / f"{lang_a}.yaml", a), merge(folder / f"{lang_b}.yaml", b)
    pending_path = folder / f"pending-{lang_a}-{lang_b}.yaml"
    pending_path.write_text(yaml.safe_dump(pending, allow_unicode=True, sort_keys=True), encoding="utf-8")
    print(
        f"Добавени {added_a} термина в {lang_a}.yaml и {added_b} в {lang_b}.yaml; "
        f"{len(pending)} за проверка в {pending_path.name}. Цена ${usage.cost_usd:.2f}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
