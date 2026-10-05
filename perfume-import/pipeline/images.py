"""Check the packshots research found (SPEC §6, first step): download each one, measure it, pick the largest.

The model's URLs can be dead and its width/height are guesses, so only a picture that actually downloads counts.
No AI, no cost. Background removal, layout and export stay in Phase 3.
"""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from io import BytesIO
from urllib.parse import urlparse

from pipeline.fields import Field

# Many shops refuse requests without a browser user agent.
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
TIMEOUT = 20
MAX_BYTES = 40_000_000


class FetchError(Exception):
    """The picture could not be downloaded; the message says why in Bulgarian."""


@dataclass
class Checked:
    url: str
    source: str = ""
    width: int = 0
    height: int = 0
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.error is None


def host(url: str) -> str:
    return urlparse(url).netloc.lower().removeprefix("www.")


def fetch(url: str) -> bytes:
    import httpx

    try:
        with httpx.stream(
            "GET", url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT, follow_redirects=True
        ) as response:
            if response.status_code >= 400:
                raise FetchError(f"HTTP {response.status_code}")
            data = b""
            for chunk in response.iter_bytes():
                data += chunk
                if len(data) > MAX_BYTES:
                    raise FetchError("файлът е по-голям от 40 MB")
            return data
    except httpx.HTTPError as exc:
        raise FetchError(f"не се свали ({type(exc).__name__})") from exc


def check(image: dict, fetch_fn=None) -> Checked:
    from PIL import Image, UnidentifiedImageError

    checked = Checked(url=image["url"], source=image.get("source", ""))
    try:
        data = (fetch_fn or fetch)(image["url"])
        with Image.open(BytesIO(data)) as im:
            checked.width, checked.height = im.size
    except FetchError as exc:
        checked.error = str(exc)
    except (UnidentifiedImageError, OSError):
        checked.error = "не е снимка"
    return checked


def check_all(images: list[dict], fetch_fn=None) -> list[Checked]:
    """Every candidate, in the order research returned them."""
    unique = list({i["url"]: i for i in images if i.get("url")}.values())
    if not unique:
        return []
    with ThreadPoolExecutor(max_workers=min(4, len(unique))) as pool:
        return list(pool.map(lambda i: check(i, fetch_fn), unique))


def best(checked: list[Checked]) -> Checked | None:
    working = [c for c in checked if c.ok]
    return max(working, key=lambda c: (c.height, c.width)) if working else None


def image_field(checked: list[Checked], min_height: int) -> Field:
    sources = [asdict(c) for c in checked]
    if not checked:
        return Field("image", "", "ai_research", "blocked", message="Проучването не намери снимка.")
    chosen = best(checked)
    if chosen is None:
        reasons = "; ".join(f"{host(c.url)}: {c.error}" for c in checked)
        return Field(
            "image",
            "",
            "ai_research",
            "blocked",
            sources=sources,
            message=f"Нито една от намерените снимки ({len(checked)}) не се сваля: {reasons}. Качи снимка ръчно.",
        )
    size = f"{chosen.width}×{chosen.height} px"
    f = Field("image", chosen.url, "ai_research", "suggested", sources=sources)
    others = len(checked) - 1
    tail = f" Избрана е най-голямата от {len(checked)}." if others else ""
    if chosen.height < min_height:
        f.status = "warning"
        f.message = (
            f"Снимка от {host(chosen.url)}, {size}: под минимума {min_height} px височина. "
            f"Няма да се уголемява; потърси по-голяма.{tail}"
        )
    else:
        f.message = f"Снимка от {host(chosen.url)}, {size}. Провери, че е официална.{tail}"
    return f
