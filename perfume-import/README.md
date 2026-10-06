# Perfume Import

Превръща кратък списък с парфюми в пълни, проверени Shopify продукти за всеки магазин от група.
Как работи и правилата: `CLAUDE.md`, `docs/SPEC.md`, `docs/DESIGN.md`.

## Статус по фази
| Фаза (SPEC §9) | Статус |
|---|---|
| 1. detect_store, config, builder, validate (одит) | ✓ готова (`docs/phase1-report.md`) |
| 2. Проучване, описания и ноти, запис в БД | ✓ готова, проверена на живо (`docs/phase2-report.md`) |
| 3. Обработка на снимките | ✓ готова, видът чака одобрение (решение #12) |
| 4. Приложение: партиди, преглед по продукт, таблица, панел за поле, опашка | ✓ готова (решение #13) |
| 5. Качване в Shopify | ✓ готова, тествана с фалшив Shopify; чака домейн и достъп на първия магазин (решение #14) |
| 6. Нов магазин, `/new-group`, CSV с поправки | предстои |

## Структура
- `pipeline/` — Python 3.12: профили на магазини, детерминистични полета, валидация
- `scripts/` — CLI: `detect_store.py`, `validate.py`, `new_batch.py`, `learn_layout.py`, `compose_images.py` и др.
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
4. Снимките се пазят на постоянен диск `perfume-media` (5 GB, `/var/data/media` = `MEDIA_DIR`). Дискът иска платен
   план (starter е достатъчен); при всеки deploy услугата спира за кратко, защото Render не прави deploy без прекъсване
   за услуги с диск.

## Приложението (Фаза 4)
```bash
make api                              # API на :8000
make app                              # http://localhost:5173
python scripts/seed_demo.py --audits  # демо партида от истински продукти от двата експорта + два одита (без AI)
```
Екрани по одобрените макети (`design/mockups/`): Партиди → Продукт (основният преглед) → Реши чакащите
(опашка, 1–3 / Enter / S) и Таблица (стрелки, Enter, A приеми, E промени, Esc). Името на преглеждащия се пита
веднъж и се записва към всяко решение (до свързване с входа на екипа).

## Качване в Shopify (Фаза 5)
Одобрените продукти се качват от екрана „Качване“ на партидата (като чернови или активни). Повторно качване
обновява вече качените, без дубликати; „Опитай отново неуспешните“ праща само неуспешните.

Свързване на магазин (веднъж за всеки):
1. Домейнът `…myshopify.com` в `config/groups/<група>/stores.yaml` (`shop:`). Не е тайна, стои в репото.
2. В Shopify: Dev Dashboard (dev.shopify.com/dashboard или от админа: името на магазина → Dev Dashboard) →
   Create app → права (scopes) `write_products`, `read_products`, `write_files`, `read_files` → инсталирай в магазина.
3. В Render → Environment: `SHOPIFY_CLIENT_ID_<МАГАЗИН>` и `SHOPIFY_CLIENT_SECRET_<МАГАЗИН>` от приложението
   (напр. `SHOPIFY_CLIENT_ID_PARFEMIJA`). Сървърът сам взема токен за 24 часа. Ако магазинът вече има стар
   custom app с готов токен (`shpat_…`), стига `SHOPIFY_TOKEN_<МАГАЗИН>`. Никога в репото или в чата.

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

## Снимки (Фаза 3)
Без AI и без цена. Шаблонът (платно, фон, къде стои шишето) се измерва от сегашните снимки в експортите;
партидата сглобява най-голямата намерена снимка върху него за всеки магазин и записва оригинала и резултата в `MEDIA_DIR`
(таблица `media`, `GET /api/media/{id}`).

```bash
python scripts/learn_layout.py --group group-1 premierparfums=<export.csv> parfemija=<export.csv>  # config/groups/<g>/image/layout.yaml
python scripts/compose_images.py --batch 12                # пресглобява партида (напр. след нов layout) + контролен лист в output/
python scripts/compose_images.py --batch 12 --sheet-only   # само контролен лист
```
`pytest -m rembg` пуска истинския модел за махане на фона (сваля u2net, ~176 MB, при първо пускане).
