---
description: Create a batch of new perfumes for a store group
argument-hint: <input.csv> --group <group> [--stores a,b] [--upload]
---
Input: $ARGUMENTS
1. Load config for the group (docs/SPEC.md §2). Validate the input file: required columns, one price column per selected store, EAN checksum. Report problems and stop if the file is unusable.
2. Normalize each row (brand, name, concentration, ml, tester).
3. Launch one `perfume-researcher` subagent per product, in parallel (max 10 at a time).
4. Build store fields, generate descriptions and localized notes, run the image pipeline.
5. Run validate.py, save the batch to the DB, print: batch link, counts ok / suggested / blocked per store.
6. Only with --upload and only for products with no blocked or unaccepted fields: upload as drafts.
