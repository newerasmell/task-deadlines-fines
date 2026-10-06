#!/usr/bin/env python
"""Propose vocab values for gender / fragrance family values outside vocab.yaml (docs/decisions.md #5).

    python scripts/suggest_vocab.py --audit tests/fixtures/parfemija_export.csv --group group-1 --store parfemija

Writes output/vocab-suggestions-<store>.yaml; with --save also stores them as suggested in vocab_learned.
"""

import argparse
import sys
from collections import Counter
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pipeline.ai import api_key  # noqa: E402
from pipeline.config import load_group  # noqa: E402
from pipeline.export import load_export  # noqa: E402
from pipeline.validate import CONTROLLED, audit  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--audit", required=True, metavar="EXPORT")
    ap.add_argument("--group", required=True)
    ap.add_argument("--store", required=True)
    ap.add_argument("--save", action="store_true", help="store as suggested in vocab_learned")
    args = ap.parse_args()

    group = load_group(args.group)
    report = audit(load_export(args.audit), group, args.store)
    unknown = {key: Counter() for key in CONTROLLED}
    for p in report.products:
        for key in CONTROLLED:
            f = p.fields.get(key)
            if f and f.rule == f"{key}_unknown":
                unknown[key][f.value] += 1
    total = sum(len(c) for c in unknown.values())
    print(f"{total} различни непознати стойности: " + ", ".join(f"{k} {len(c)}" for k, c in unknown.items()))
    if not total:
        return 0
    if not api_key():
        print("Липсва ключ: задай PERFUME_ANTHROPIC_API_KEY (или ANTHROPIC_API_KEY) в средата, не в репото.")
        return 2

    from pipeline.ai import Usage, default_client
    from pipeline.suggest import suggest_vocab

    client, usage, out = default_client(), Usage(), {}
    for key, values in unknown.items():
        if values:
            s = suggest_vocab(client, key, dict(values), list(group.vocab[key]))
            usage.add(s.usage)
            out[key] = s.items
    path = Path("output") / f"vocab-suggestions-{args.store}.yaml"
    path.parent.mkdir(exist_ok=True)
    path.write_text(yaml.safe_dump(out, allow_unicode=True, sort_keys=False), encoding="utf-8")
    mapped = sum(1 for items in out.values() for i in items if i["canonical"])
    print(f"{mapped} от {total} имат предложение. Цена ${usage.cost_usd:.2f}. Файл: {path}")
    if args.save:
        from db.repo import save_vocab_suggestions

        print(f"Записани {save_vocab_suggestions(args.group, out)} предложения (статус suggested).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
