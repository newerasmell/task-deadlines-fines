---
description: Create a batch of new perfumes for a store group
argument-hint: <input.csv> --group <group> [--stores a,b] [--limit N]
---
Input: $ARGUMENTS
1. Run `python scripts/new_batch.py $ARGUMENTS --estimate` and show the user the input problems and the expected cost.
2. Only after the user confirms the cost, run `python scripts/new_batch.py $ARGUMENTS` (needs ANTHROPIC_API_KEY in the
   environment). Research, texts, per-store fields and validation all run in `pipeline/` (see docs/SPEC.md §1, §4, §5).
3. Report the batch number, counts ok / for review / blocked per store and the real cost per product from the output.
Upload to Shopify is phase 5; never upload from here.
