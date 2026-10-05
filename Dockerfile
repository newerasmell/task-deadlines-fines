# Stage 1: build the React app.
FROM node:22-slim AS app
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
RUN npm run build

# Stage 2: Python API that also serves the built app.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY pyproject.toml ./
COPY pipeline/ pipeline/
COPY api/ api/
COPY db/ db/
RUN pip install --no-cache-dir .
COPY alembic.ini ./
COPY config/ config/
COPY --from=app /app/dist app/dist
# Render sets PORT; migrations run on every start and are no-ops when up to date.
CMD ["sh", "-c", "alembic upgrade head && uvicorn api.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
