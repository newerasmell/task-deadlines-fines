# Perfume Import

Превръща кратък списък с парфюми в пълни, проверени Shopify продукти за всеки магазин от група.
Как работи и правилата: `CLAUDE.md`, `docs/SPEC.md`, `docs/DESIGN.md`.

## Структура
- `pipeline/` — Python 3.12: профили на магазини, детерминистични полета, валидация
- `scripts/` — CLI: `detect_store.py`, `validate.py`
- `api/` — FastAPI; в продукция сервира и билднатия app
- `db/` — SQLAlchemy модели и Alembic миграции (Postgres)
- `app/` — React + Vite + TypeScript
- `config/` — групи, магазини, речници, глосари

## Локално
Нужни: Python 3.12, Node 22, Docker.

```bash
cp .env.example .env      # DATABASE_URL вече сочи към локалния Postgres
make setup                # venv + зависимости
make db                   # Postgres 16 в Docker (docker-compose.yml)
make migrate              # схема
make api                  # http://localhost:8000/api/health
make app                  # http://localhost:5173 (проксира /api към :8000)
make test                 # тестове; тези с маркер db искат работещ Postgres
```

## Деплой в Render
`render.yaml` е Blueprint: web service (Docker, API + app) и Postgres база.
1. Render → New → Blueprint → избери репото `task-deadlines-fines` и посочи пътя `perfume-import/render.yaml`
   (проектът е в подпапка; deploy се пуска само при промени в `perfume-import/`).
2. Render пита за всеки `SHOPIFY_TOKEN_*` (`sync: false`). Попълни ги там. Токени никога не влизат в репото.
3. `DATABASE_URL` идва автоматично от базата. Миграциите се пускат при всеки старт.

## Нова партида (Фаза 2)
Нужна е променлива `ANTHROPIC_API_KEY` (в `.env` локално, в Render като env var; никога в репото).

```bash
python scripts/new_batch.py input/sample-5.csv --group group-1 --stores premierparfums,parfemija --estimate  # без AI
python scripts/new_batch.py input/sample-5.csv --group group-1 --stores premierparfums,parfemija            # проучване + текстове + запис
python scripts/suggest_vocab.py --audit <export.csv> --group group-1 --store <key> [--save]                # решение #5
python scripts/build_glossary.py config/glossary/pairs/el-hr.yaml                                         # решение #7
```
Модел: Claude Opus 5.5. Цената на всяко повикване се записва (`events.kind = ai_usage`). `pytest -m live` пуска един реален продукт.
