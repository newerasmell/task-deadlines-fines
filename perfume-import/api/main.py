from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import create_engine, text

from pipeline import media
from pipeline.settings import get_settings

settings = get_settings()
engine = create_engine(settings.sqlalchemy_url, pool_pre_ping=True)

app = FastAPI(title="Perfume Import")


@app.get("/api/health")
def health():
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1"))
    except Exception as exc:  # report, don't crash: health must always answer
        return JSONResponse({"status": "error", "db": f"няма връзка с базата: {exc.__class__.__name__}"}, 503)
    return {"status": "ok", "db": "ok"}


@app.get("/api/media/{media_id}")
def get_media(media_id: int):
    """A stored picture (original or finished). Files are named by their content, so they never change."""
    from db.repo import get_media as find

    row = find(media_id)
    if row is None:
        return JSONResponse({"error": "Няма такава снимка."}, 404)
    path = media.resolve(row.path)
    if not path.is_file():
        return JSONResponse({"error": "Файлът липсва на диска (MEDIA_DIR)."}, 404)
    cache = {"Cache-Control": "public, max-age=31536000, immutable"}
    return FileResponse(path, media_type=row.content_type, headers=cache)


# In production the built React app is served from the same origin as the API.
if settings.app_dist.is_dir():
    app.mount("/assets", StaticFiles(directory=settings.app_dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        file = settings.app_dist / path
        if path and file.is_file():
            return FileResponse(file)
        return FileResponse(settings.app_dist / "index.html")
