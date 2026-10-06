"""Learn how a store presents its main image (SPEC §6), from the images already in its catalog.

For each picture: is the background one flat colour (or transparent)? Where is the bottle (its bounding box as a
share of the canvas)? Pictures with a designed background (e.g. the 15 ml decant template) are counted but left
out of the measurement. The result is the group's layout.yaml; a store whose own pictures differ gets an override.
"""

from collections import Counter
from dataclasses import dataclass
from io import BytesIO
from statistics import median

from PIL import Image

FLAT_TOLERANCE = 12  # max channel difference that still counts as the background colour
EDGE_SAMPLES = 40  # pixels sampled along each edge


@dataclass
class Measured:
    width: int
    height: int
    background: str  # "transparent" or "#RRGGBB"
    box: tuple[float, float, float, float]  # left, top, right, bottom as shares of the canvas
    format: str

    @property
    def height_share(self) -> float:
        return self.box[3] - self.box[1]

    @property
    def width_share(self) -> float:
        return self.box[2] - self.box[0]

    @property
    def center_x(self) -> float:
        return (self.box[0] + self.box[2]) / 2

    @property
    def top_margin(self) -> float:
        return self.box[1]

    @property
    def bottom_margin(self) -> float:
        return 1 - self.box[3]


def _edge_pixels(im: Image.Image) -> list[tuple]:
    w, h = im.size
    points = []
    for i in range(EDGE_SAMPLES):
        x = int(i * (w - 1) / (EDGE_SAMPLES - 1))
        y = int(i * (h - 1) / (EDGE_SAMPLES - 1))
        points += [(x, 0), (x, h - 1), (0, y), (w - 1, y)]
    return [im.getpixel(p) for p in points]


def _close(a: tuple, b: tuple) -> bool:
    return max(abs(x - y) for x, y in zip(a[:3], b[:3], strict=True)) <= FLAT_TOLERANCE


def measure(data: bytes) -> Measured | None:
    """None when the background is not flat (a designed template), so it cannot define the layout."""
    src = Image.open(BytesIO(data))
    fmt = (src.format or "PNG").upper()
    im = src.convert("RGBA")
    w, h = im.size
    edges = _edge_pixels(im)
    if all(p[3] < 16 for p in edges):
        mask = im.split()[3].point(lambda a: 255 if a > 16 else 0)
        background = "transparent"
    else:
        colours = Counter(p[:3] for p in edges if p[3] > 240)
        if not colours:
            return None
        base, _ = colours.most_common(1)[0]
        if sum(_close(p, base) for p in edges) / len(edges) < 0.95:
            return None
        rgb = im.convert("RGB")
        # Foreground = any channel further than the tolerance from the background colour.
        bands = [
            b.point(lambda v, c=c: 255 if abs(v - c) > FLAT_TOLERANCE else 0)
            for b, c in zip(rgb.split(), base, strict=True)
        ]
        mask = bands[0]
        for band in bands[1:]:
            mask = Image.composite(band, mask, band)
        alpha = im.split()[3].point(lambda a: 255 if a > 16 else 0)
        mask = Image.composite(mask, Image.new("L", im.size, 0), alpha)
        background = "#{:02X}{:02X}{:02X}".format(*base)
    bbox = mask.getbbox()
    if bbox is None:
        return None
    left, top, right, bottom = bbox
    return Measured(w, h, background, (left / w, top / h, right / w, bottom / h), fmt)


def learn(images: list[bytes]) -> dict:
    """The layout most of the store's pictures follow, with how many match."""
    measured = [m for m in (measure(d) for d in images) if m]
    designed = len(images) - len(measured)
    if not measured:
        raise ValueError("Нито една снимка няма равен фон; шаблонът не може да се измери. Качи background.png ръчно.")
    sizes = Counter((m.width, m.height) for m in measured)
    canvas, _ = sizes.most_common(1)[0]
    backgrounds = Counter("#FFFFFF" if m.background == "transparent" else m.background for m in measured)
    background, _ = backgrounds.most_common(1)[0]
    formats = Counter(m.format for m in measured)
    height_share = median(m.height_share for m in measured)
    # The box is limited by height; width only stops very wide bottles (round ones) from touching the edges.
    width_share = max(m.width_share for m in measured)
    top, bottom = median(m.top_margin for m in measured), median(m.bottom_margin for m in measured)
    anchor = "center" if abs(top - bottom) <= 0.03 else ("bottom" if bottom < top else "top")
    within = sum(abs(m.height_share - height_share) <= 0.06 for m in measured) / len(measured)
    return {
        "canvas": [canvas[0], canvas[1]],
        "background": {"color": background},
        "format": formats.most_common(1)[0][0].lower().replace("jpeg", "jpg"),
        "product": {
            "max_height": round(height_share, 3),
            "max_width": round(min(width_share, 0.9), 3),
            "center_x": round(median(m.center_x for m in measured), 3),
            "anchor": anchor,
            "bottom_margin": round(bottom, 3),
        },
        "learned_from": {
            "images": len(images),
            "flat_background": len(measured),
            "designed_background": designed,
            "canvas_sizes": {f"{w}x{h}": n for (w, h), n in sizes.most_common()},
            "backgrounds": dict(backgrounds),
            "height_share_match_rate": round(within, 3),
        },
    }
