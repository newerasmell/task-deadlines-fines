from fastapi import Depends, FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import create_engine, text

from api.auth import require_user
from api.auth import router as auth_router
from api.batches import router as batches_router
from api.review import router as review_router
from api.stores import router as stores_router
from db.stores import install as install_store_settings
from pipeline import media
from pipeline.settings import get_settings

settings = get_settings()
engine = create_engine(settings.sqlalchemy_url, pool_pre_ping=True)

app = FastAPI(title="Perfume Import")
app.add_middleware(GZipMiddleware, minimum_size=2000)  # an audit batch is ~8 MB of JSON, ~1 MB gzipped
logged_in = [Depends(require_user)]  # everything but health and login needs a session
app.include_router(auth_router)
app.include_router(batches_router, dependencies=logged_in)  # before review: /api/batches/check ≠ /api/batches/{id}
app.include_router(review_router, dependencies=logged_in)
app.include_router(stores_router, dependencies=logged_in)
install_store_settings()  # stores and Shopify domains set in the app are part of the group config


@app.get("/api/health")
def health():
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1"))
    except Exception as exc:  # report, don't crash: health must always answer
        return JSONResponse({"status": "error", "db": f"няма връзка с базата: {exc.__class__.__name__}"}, 503)
    return {"status": "ok", "db": "ok"}


@app.get("/api/media/{media_id}", dependencies=logged_in)
def get_media(media_id: int):
    """A stored picture (original or finished). Files are named by their content, so they never change."""
    from db.repo import get_media as find

    row = find(media_id)
    if row is None:
        return JSONResponse({"error": "Няма такава снимка."}, 404)
    path = media.resolve(row.path)
    if not path.is_file():
        return JSONResponse({"error": "Файлът липсва на диска (MEDIA_DIR)."}, 404)
    cache = {"Cache-Control": "private, max-age=31536000, immutable"}
    return FileResponse(path, media_type=row.content_type, headers=cache)


# In production the built React app is served from the same origin as the API.
if settings.app_dist.is_dir():
    app.mount("/assets", StaticFiles(directory=settings.app_dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        file = settings.app_dist / path
        if path.startswith("api/"):  # an unknown API path is a 404, not the app
            return JSONResponse({"detail": "Няма такъв адрес."}, 404)
        if path and file.is_file():
            return FileResponse(file)
        return FileResponse(settings.app_dist / "index.html")
