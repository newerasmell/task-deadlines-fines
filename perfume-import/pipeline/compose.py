"""Finished main image (SPEC §6): cut the bottle out, place it on the store's background per layout.yaml.

The bottle is only ever scaled DOWN (CLAUDE.md #7). A smaller picture keeps its real size, centred in the box,
and the field becomes a warning. Background removal runs locally (rembg, model u2net): no AI cost.
"""

import threading
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path

import yaml
from PIL import Image

from pipeline.config import Group

ALPHA_CUT = 8  # alpha below this is background when cropping
_session = None
_lock = threading.Lock()


@dataclass
class Layout:
    key: str  # "group" or the store key with its own layout
    canvas: tuple[int, int]
    background: str | None  # "#RRGGBB"
    background_file: Path | None
    format: str
    max_height: float
    max_width: float
    center_x: float
    anchor: str
    bottom_margin: float


@dataclass
class Composed:
    layout: str
    data: bytes
    width: int
    height: int
    bottle: tuple[int, int]  # size of the bottle on the canvas
    scaled: float  # 1.0 = original size (never above)
    warnings: list[str] = field(default_factory=list)

    @property
    def extension(self) -> str:
        return "jpg" if self.data[:3] == b"\xff\xd8\xff" else "png"


def load_layout(group: Group, store_key: str | None = None) -> Layout:
    path = group.path / "image" / "layout.yaml"
    if not path.exists():
        raise FileNotFoundError(f"Няма {path}. Пусни scripts/learn_layout.py за групата.")
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    key = "group"
    if store_key and store_key in (raw.get("stores") or {}):
        raw, key = {**raw, **raw["stores"][store_key]}, store_key
    product = raw["product"]
    background_file = group.path / "image" / "background.png"
    return Layout(
        key=key,
        canvas=(int(raw["canvas"][0]), int(raw["canvas"][1])),
        background=(raw.get("background") or {}).get("color"),
        background_file=background_file if background_file.exists() else None,
        format=raw.get("format", "png"),
        max_height=float(product["max_height"]),
        max_width=float(product["max_width"]),
        center_x=float(product.get("center_x", 0.5)),
        anchor=product.get("anchor", "center"),
        bottom_margin=float(product.get("bottom_margin", 0.08)),
    )


def _rembg(data: bytes) -> Image.Image:
    global _session
    from rembg import new_session, remove

    with _lock:
        if _session is None:
            _session = new_session("u2net")
        out = remove(data, session=_session)
    return Image.open(BytesIO(out)).convert("RGBA")


FLOOD_TOLERANCE = 18  # how far from the background colour the flood fill still spreads
SENTINEL = (255, 0, 255)


def _flat_background(im: Image.Image) -> tuple | None:
    """The background colour if the picture's edges are one flat colour (most shop packshots: white)."""
    from pipeline.layout import _close, _edge_pixels

    edges = [p for p in _edge_pixels(im) if p[3] > 240]
    if not edges:
        return None
    base = max(set(p[:3] for p in edges), key=lambda c: sum(_close(p, c) for p in edges))
    return base if sum(_close(p, base) for p in edges) / len(edges) >= 0.6 else None


def _flood_cut(im: Image.Image, base: tuple) -> Image.Image:
    """Remove only the background connected to the edges. Light parts inside the bottle (a silver cap, a white
    label) are not connected to the edge through background, so they stay; a neural cut-out can drop them."""
    from PIL import ImageChops, ImageDraw, ImageFilter

    from pipeline.layout import _close

    rgb = im.convert("RGB")
    w, h = rgb.size
    step = max(1, max(w, h) // 200)
    for i in range(0, max(w, h), step):
        for xy in ((min(i, w - 1), 0), (min(i, w - 1), h - 1), (0, min(i, h - 1)), (w - 1, min(i, h - 1))):
            pixel = rgb.getpixel(xy)
            if pixel != SENTINEL and _close(pixel, base):
                ImageDraw.floodfill(rgb, xy, SENTINEL, thresh=FLOOD_TOLERANCE)
    # Background = exactly the sentinel colour after the fill; everything else is the bottle.
    r, g, b = rgb.split()
    keep = Image.merge(
        "RGB",
        (
            r.point(lambda v: 0 if v == 255 else 255),
            g.point(lambda v: 0 if v == 0 else 255),
            b.point(lambda v: 0 if v == 255 else 255),
        ),
    )
    keep = keep.convert("L").point(lambda v: 255 if v else 0)  # any channel off the sentinel -> keep
    keep = ImageChops.darker(keep, keep.filter(ImageFilter.GaussianBlur(0.8)))  # soften inward only: no halo
    out = im.convert("RGBA")
    out.putalpha(ImageChops.multiply(keep, out.split()[3]))
    return out


def touches_edge(cutout: Image.Image) -> bool:
    """The bottle reaches the picture's border: the source is probably cropped (a cap or base cut off)."""
    bbox = cutout.split()[3].point(lambda a: 255 if a >= ALPHA_CUT else 0).getbbox()
    if bbox is None:
        return False
    w, h = cutout.size
    return bbox[1] <= 1 or bbox[3] >= h - 1


def cut_out(data: bytes, remover=None) -> Image.Image:
    """The bottle on a transparent background. Already transparent -> as it is; flat background -> flood fill
    from the edges; anything else (a scene, a gradient) -> rembg."""
    im = Image.open(BytesIO(data)).convert("RGBA")
    w, h = im.size
    corners = [im.getpixel(p)[3] for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1))]
    if max(corners) < 16:
        return im
    base = _flat_background(im)
    if base is not None:
        return _flood_cut(im, base)
    return (remover or _rembg)(data)


def compose(cutout: Image.Image, layout: Layout) -> Composed:
    alpha = cutout.split()[3].point(lambda a: 255 if a >= ALPHA_CUT else 0)
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError("След махането на фона не остана нищо от снимката.")
    bottle = cutout.crop(bbox)
    cw, ch = layout.canvas
    box_w, box_h = int(cw * layout.max_width), int(ch * layout.max_height)
    scale = min(box_w / bottle.width, box_h / bottle.height, 1.0)  # never up
    warnings = []
    if scale < 1.0:
        bottle = bottle.resize(
            (max(1, round(bottle.width * scale)), max(1, round(bottle.height * scale))), Image.LANCZOS
        )
    elif bottle.height < box_h * 0.95 and bottle.width < box_w * 0.95:
        warnings.append(
            f"Шишето е {bottle.width}×{bottle.height} px, а полето е {box_w}×{box_h} px; не се уголемява, "
            "затова изглежда по-малко от другите. Потърси по-голяма снимка."
        )
    if layout.background_file:
        canvas = Image.open(layout.background_file).convert("RGBA").resize((cw, ch))
    else:
        canvas = Image.new("RGBA", (cw, ch), layout.background or "#FFFFFF")
    x = round(cw * layout.center_x - bottle.width / 2)
    if layout.anchor == "bottom":
        y = ch - round(ch * layout.bottom_margin) - bottle.height
    elif layout.anchor == "top":
        y = round(ch * (1 - layout.max_height - layout.bottom_margin))
    else:
        y = round((ch - bottle.height) / 2)
    canvas.alpha_composite(bottle, (max(0, x), max(0, y)))
    buf = BytesIO()
    if layout.format in ("jpg", "jpeg"):
        canvas.convert("RGB").save(buf, "JPEG", quality=92)
    else:
        canvas.convert("RGB").save(buf, "PNG", optimize=True)
    return Composed(layout.key, buf.getvalue(), cw, ch, (bottle.width, bottle.height), round(scale, 3), warnings)


def compose_for_stores(data: bytes, group: Group, stores: list[str], remover=None) -> dict[str, Composed]:
    """One cut-out, one composition per distinct layout; stores sharing a layout share the picture."""
    cutout = cut_out(data, remover)
    cropped = touches_edge(cutout)
    by_layout: dict[str, Composed] = {}
    out = {}
    for store in stores:
        layout = load_layout(group, store)
        if layout.key not in by_layout:
            by_layout[layout.key] = compose(cutout, layout)
            if cropped:
                by_layout[layout.key].warnings.append(
                    "Шишето опира в горния или долния край на източника: вероятно е отрязано (капачка или дъно). "
                    "Провери снимката или потърси друга."
                )
        out[store] = by_layout[layout.key]
    return out
