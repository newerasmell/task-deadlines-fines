---
description: Create a new store group from 1-3 Shopify exports of its stores
argument-hint: --group <group-key> --name "<name>" <store>=<export.csv> [<store>=<export.csv> ...]
---
Input: $ARGUMENTS
1. Run `python scripts/new_group.py $ARGUMENTS`. It profiles every export (no AI, no cost) and writes
   config/groups/<group>/group.yaml, vocab.yaml, import_template.csv and description.md (stores.yaml is kept).
2. Show the user what to confirm from the output (items below 90% match, metafields the system does not fill,
   formulas the stores disagree on) and the generated group.yaml.
3. Adapt description.md with the user (it starts from group-1's guide) and fix anything they correct.
4. Run `pytest -q tests/test_config.py` to check the group loads, then commit on the working branch.
After that, the group's stores can be added in the app (Магазини → Добави магазин), which audits each export.
