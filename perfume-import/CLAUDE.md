# Perfume Import

Turns a short product list (name, ml, tester flag, EAN, price per store) into complete, validated Shopify products for every store in a store group, plus a finished main image per store. A web app lets the team review every field, see what the AI found or suggested, fix errors and upload.

Read before any work: `docs/SPEC.md` (architecture, data model, rules) and, for any UI work, `docs/DESIGN.md`.

## Core principles
1. Every store has its own profile, learned from its uploaded product export (`detect_store.py`), stored in the DB and editable in the app. New products are always rendered by the profile of the target store. Groups are only an organizing label plus shared defaults (vocab, description guide) used when a store has no profile yet; a store's profile always wins. Research is done once per product and reused by all stores. Nothing store-specific is hardcoded.
2. Every field value carries provenance: `origin`, `status`, `confidence`, `sources`, `alternatives`, `previous` (see SPEC §3). Never write a bare value.
3. Deterministic fields are built by code from the group template, never by the AI: title, handle, SKU (which carries the EAN, `SK{ean}`), ml, product type, fixed columns, the tester sentence. The AI only researches facts and writes prose.
4. Controlled fields (gender, fragrance family) are picked from `vocab.yaml`. Free text is never written into them.
5. English is the master for all localized content; every localized field stores and shows its English reference (`value_en`).
6. The AI never guesses an EAN or a price. Missing ones are `blocked`.
7. Images are never upscaled. Below the minimum resolution → `warning`, keep the original.
8. Nothing reaches Shopify unless it has no `blocked` fields and every `suggested` field has been accepted in the app.

## Conventions
- Python 3.12 for pipeline and API (FastAPI), Postgres, React + Vite + TypeScript for the app.
- App UI language: Bulgarian. Product content: the store's language.
- Secrets only in `.env` (`SHOPIFY_TOKEN_<STORE_KEY>`), never committed.
- Work in the phases in SPEC §9; finish and test one phase before starting the next.
- For UI: follow DESIGN.md exactly, build one screen at a time, screenshot it with Playwright and critique against DESIGN.md before moving on.
