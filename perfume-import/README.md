# Perfume Import

Превръща кратък списък с парфюми в пълни, проверени Shopify продукти за всеки магазин от група.
Как работи и правилата: `CLAUDE.md`, `docs/SPEC.md`, `docs/DESIGN.md`.

## Статус по фази
| Фаза (SPEC §9) | Статус |
|---|---|
| 1. detect_store, config, builder, validate (одит) | ✓ готова (`docs/phase1-report.md`) |
| 2. Проучване, описания и ноти, запис в БД | ✓ готова, проверена на живо (`docs/phase2-report.md`) |
| 3. Обработка на снимките | в работа |
| 4. Приложение | предстои |
| 5. Качване в Shopify | предстои |
| 6. Нов магазин, `/new-group`, CSV с поправки | предстои |

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
Нужна е променлива `PERFUME_ANTHROPIC_API_KEY` (в `.env` локално, в средата на Claude Code; в Render може и `ANTHROPIC_API_KEY`). Никога в репото. Claude Code облачните среди не подават `ANTHROPIC_API_KEY` към сесиите.

```bash
python scripts/new_batch.py input/sample-5.csv --group group-1 --stores premierparfums,parfemija --estimate  # без AI
python scripts/new_batch.py input/sample-5.csv --group group-1 --stores premierparfums,parfemija            # проучване + текстове + запис
python scripts/new_batch.py input/x.csv --group group-1 --deep 3614270581656,737052925127                   # избрани продукти задълбочено
python scripts/research_again.py --ean 3614270581656 --tier deep                                          # един продукт наново, нова партида
python scripts/suggest_vocab.py --audit <export.csv> --group group-1 --store <key> [--save]                # решение #5
python scripts/build_glossary.py config/glossary/pairs/el-hr.yaml                                         # решение #7
```
Режими: евтин (Sonnet 5.5, ≤ $0.125/продукт (таван $0.15), по подразбиране) и задълбочен (Opus 5.5, ≤ $0.50, таван $0.60); колона `research` във входа избира за всеки ред. Цената на всяко повикване се записва (`events.kind = ai_usage`). `pytest -m live` пуска един реален продукт.
