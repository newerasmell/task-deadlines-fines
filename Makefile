PY := .venv/bin/python

.PHONY: setup db migrate api app test lint

setup:            ## venv + Python and app dependencies
	python3.12 -m venv .venv
	.venv/bin/pip install -e ".[dev]"
	cd app && npm install

db:               ## start local Postgres and wait until it is ready
	docker compose up -d --wait db

migrate:
	.venv/bin/alembic upgrade head

api:
	.venv/bin/uvicorn api.main:app --reload --port 8000

app:
	cd app && npm run dev

test:
	.venv/bin/pytest

lint:
	.venv/bin/ruff check . && .venv/bin/ruff format --check .
