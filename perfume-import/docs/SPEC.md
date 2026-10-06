# Specification

## 1. Flow
1. Team fills `input/<batch>.csv` (template: `input/products_template.csv`) or pastes rows in the app.
2. `/new-perfumes <file> --group group-1` (Claude Code) or "New batch" in the app runs the pipeline:
   normalize → research (parallel subagents) → build fields per store → images → validate → save batch to DB.
3. Team reviews in the app, accepts/edits AI suggestions, resolves blocked fields.
4. "Upload" sends approved products to each store as drafts (or active, per batch setting).

## 2. Store profiles (core concept)
Each store gets a profile from its own catalog export, uploaded in the app (Stores → Upload catalog). No profile files are written by hand.
`detect_store.py <export> --store <key>` produces a profile with, per item, the detected value, match rate and examples:
- content language (detected from body/notes), title language, currency, markets
- title pattern (e.g. `{brand} {name} {concentration_short} {ml} ml[ TESTER]`) and tester marker
- SKU pattern (e.g. `SK{ean}`), where the EAN lives (barcode, metafield)
- metafield set (namespace, key, type) and, per controlled metafield, the dominant vocabulary and its variants
- description shape (length range, HTML structure, tester sentence) + 5 approved example descriptions used as style references for generation
- price pattern (rounding, compare-at ratio range), fixed columns (category, Google fields, weight, taxable, inventory policy)
- glossary pairs (note in English canonical ↔ local term) harvested from existing products
Profile items below 90% match are shown as suggestions for confirmation. Re-uploading a newer export creates a new profile version with a diff; the team accepts or rejects changes.
Group = label + defaults. When a store has no profile, the group defaults apply and the store shows as "чака каталог". `/new-group` is no longer required; a group's defaults can be derived from what its stores' profiles share.
The files in config/groups/group-1/ are a seed derived from the PremierParfums and Parfemija exports and serve as the group defaults and as test fixtures for detect_store.py.

## 2b. Config layout
```
config/groups/<group>/
  group.yaml            structure, title/SKU formulas, metafields, fixed columns, rules
  stores.yaml           stores in the group: language, currency, price rules, shop domain, token env var
  vocab.yaml            allowed values for controlled fields + known misspellings → canonical
  description.md        description style guide for this group
  import_template.csv   exact Shopify CSV columns for the group (fallback export)
  image/background.png, image/layout.yaml
config/glossary/<lang>.yaml   note translations (english canonical → local), shared by all groups
```
Adding a store = one block in stores.yaml (price column appears automatically in the input template).
Adding a group = copy an existing group folder; `/new-group` can derive group.yaml from 2–3 exported products.

## 3. Data model
Tables: `batches`, `products` (canonical, language-neutral research), `store_products` (one per product × store), `fields` (one per store_product × field), `events` (audit log), `vocab_learned`.

Field record:
```json
{
  "key": "fragrance_family",
  "value": "Oriental Floral",
  "origin": "input | template | vocab | ai_research | ai_generated | auto_fix",
  "status": "ok | suggested | fixed | warning | blocked",
  "confidence": 0.82,
  "sources": [{"url": "...", "says": "Floral Amber"}],
  "alternatives": ["Floral", "Amber"],
  "previous": null,
  "value_en": "English reference for localized fields, null for non-localized",
  "message": "Sources disagree: Fragrantica says Floral Amber, brand site says Oriental Floral",
  "decided_by": null, "decided_at": null
}
```
Status rules: `input`/`template` → ok. `vocab` with a direct source match → ok, otherwise suggested. `ai_research` → suggested unless 2+ sources agree (then ok, confidence ≥ 0.9). `ai_generated` text → suggested until first batch approvals prove quality; configurable per group (`auto_accept_generated: false`). `auto_fix` → fixed.

## 4. Research (subagent `perfume-researcher`, one per product)
Finds: brand, exact name, concentration, gender, fragrance family, top/middle/base notes (english canonical), ingredients list if published, official packshot URL(s). Preferred sources: brand site, Fragrantica, Parfumo, major retailers. Must return a source URL per fact. Output JSON into `products`.

## 5. Build per store
- English is the master language for all localized content. Notes, description and SEO text are written in English first and stored as `value_en`; every store language is produced from that English master. The app always shows the English reference under the local value, for every language (el, hr, cs, pl, ...).
- Deterministic fields from group.yaml formulas.
- Notes: english canonical → store language via `config/glossary/<lang>.yaml`; unknown note → AI translation, status suggested, added to glossary once accepted.
- Description: generated in the store language following description.md.
- Prices: from the input price column for that store; rounding + compare-at per stores.yaml.

## 6. Images
Download highest resolution packshot → remove background (rembg) → place on `image/background.png` per `layout.yaml` → export per store. Downscale only. Min source height 1000 px, else warning. Keep the original next to the result for the app's comparison view. Upload to each store's Files via Admin API before product creation.

## 7. Validation (`validate.py`, runs after build and before upload)
| Check | Result |
|---|---|
| Value outside vocab but close to a known variant (`Unsiex`, `Men’s perfume`, `Wood`) | auto_fix → canonical |
| `100ml` / wrong spacing, trailing spaces, curly quotes in controlled fields | auto_fix |
| Description or notes not in store language (language detection) | regenerate up to 2×, then blocked |
| Description length outside group range, tester sentence missing on tester | regenerate, then warning |
| Missing or invalid EAN (checksum) | blocked |
| Duplicate SKU or handle in batch or already in store | blocked |
| Missing price for a store, compare-at ≤ price, compare-at ratio outside group range | blocked |
| Image below min resolution / not found | warning / blocked |
Validator also runs standalone on a Shopify export (`validate.py --audit export.csv --group group-1 --store hr`) and loads findings into the app as an audit batch.

## 8. App screens (see DESIGN.md)
1. Batches: list with counts ready / needs review / blocked, group, date, author.
2. Batch grid: rows = products, columns = fields, tabs = stores; cell color by status; filters (only suggested, only blocked, by field); keyboard navigation.
3. Field panel (side panel on cell click): value, origin, confidence, sources with what each says, alternatives, previous value for fixes; actions Accept, Edit, Pick alternative, Regenerate. Accepting all suggestions of a column is allowed with one confirm.
4. Product view: generated image vs original with resolutions, all store versions side by side, prices per store.
5. Upload: per store results, retry failed only.
6. Audit: same grid for existing catalog exports, with "Export fix CSV".
7. Stores list (all stores, group, country/language, product count, profile state, last catalog upload; actions Upload/Update catalog). Stores → New store / Update catalog: name, Shopify domain, API token, optional country/language/currency/group, plus a full product export (.xlsx or .csv). `detect_store.py` infers: content language (language detection on body and notes), currency and markets, title pattern with match rate, SKU pattern, metafield set, vocab used and its deviations, description shape, price rounding and compare-at ratio, fixed columns. It scores the store against every existing group (columns, metafields, title and SKU formulas) and recommends one, or proposes a new group built from this store. Inferred values are shown as suggestions for confirmation. On save: the profile is stored for that store (versioned), note pairs seed the language glossary, and an audit batch is created from the same export.
8. Settings (read-only view of group/store config and vocab; edits via repo).

Auth: reuse the team task site login if deployed as a module there; roles: editor, approver.

## 9. Phases
1. detect_store.py (validated against the PremierParfums and Parfemija exports, must reproduce the seed in config/groups/group-1) + config loader + input template + deterministic field builder + validator in audit mode on the two exports (proves rules on real data).
2. Research subagent + description/notes generation + DB persistence.
3. Image pipeline.
4. App: batches, grid, field panel (design first, see DESIGN.md process).
5. Shopify upload (Files + productCreate with metafields), idempotent by SKU.
6. New store detection (screen 7), `/new-group`, audit fix-CSV export.
