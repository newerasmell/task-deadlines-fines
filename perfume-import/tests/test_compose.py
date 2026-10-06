"""Phase 3 pictures: learn the store layout, cut the bottle out, place it, never upscale."""

from io import BytesIO

import pytest
from PIL import Image, ImageDraw

from pipeline.compose import Layout, compose, compose_for_stores, cut_out, load_layout, touches_edge
from pipeline.config import load_group
from pipeline.layout import learn, measure

GROUP = load_group("group-1")


def picture(size=(1000, 1000), box=(0.3, 0.1, 0.7, 0.9), background="white", fill=(40, 30, 20), fmt="PNG"):
    w, h = size
    im = Image.new("RGB", size, background)
    draw = ImageDraw.Draw(im)
    draw.rectangle((int(w * box[0]), int(h * box[1]), int(w * box[2]) - 1, int(h * box[3]) - 1), fill=fill)
    buf = BytesIO()
    im.save(buf, fmt)
    return buf.getvalue()


def layout(**overrides) -> Layout:
    values = dict(
        key="group",
        canvas=(1080, 1080),
        background="#FFFFFF",
        background_file=None,
        format="png",
        max_height=0.8,
        max_width=0.9,
        center_x=0.5,
        anchor="center",
        bottom_margin=0.1,
    )
    return Layout(**{**values, **overrides})


def opened(c) -> Image.Image:
    return Image.open(BytesIO(c.data)).convert("RGB")


def test_measure_finds_the_bottle_box_on_a_flat_background():
    m = measure(picture(box=(0.3, 0.1, 0.7, 0.9)))
    assert m.background == "#FFFFFF"
    assert m.box == pytest.approx((0.3, 0.1, 0.7, 0.9), abs=0.002)


def test_measure_skips_designed_backgrounds():
    im = Image.linear_gradient("L").resize((500, 500)).convert("RGB")
    buf = BytesIO()
    im.save(buf, "PNG")
    assert measure(buf.getvalue()) is None


def test_learn_takes_the_typical_layout():
    images = [picture(size=(1080, 1080), box=(0.4, 0.08 + d, 0.6, 0.92 - d)) for d in (0, 0.01, 0.02)]
    images.append(picture(size=(800, 800), background=(230, 200, 220)))  # an odd one out
    learned = learn(images)
    assert learned["canvas"] == [1080, 1080]
    assert learned["background"] == {"color": "#FFFFFF"}
    assert learned["product"]["max_height"] == pytest.approx(0.82, abs=0.01)
    assert learned["product"]["anchor"] == "center"
    assert learned["learned_from"]["flat_background"] == 4


def test_group_layout_was_learned_from_the_store_images():
    lay = load_layout(GROUP, "premierparfums")
    assert lay.canvas == (1080, 1080) and lay.background == "#FFFFFF" and lay.format == "png"
    assert 0.75 < lay.max_height < 0.9


def test_flat_background_is_cut_by_flood_fill_and_keeps_light_parts_inside():
    # A dark outline around a white "label": connected to nothing outside, so it must stay.
    im = Image.new("RGB", (400, 400), "white")
    draw = ImageDraw.Draw(im)
    draw.rectangle((100, 50, 299, 349), fill=(40, 30, 20))
    draw.rectangle((140, 150, 259, 249), fill="white")
    buf = BytesIO()
    im.save(buf, "PNG")
    removed = []
    cut = cut_out(buf.getvalue(), remover=lambda data: removed.append(data))
    assert not removed  # rembg is not needed for a flat background
    alpha = cut.split()[3]
    assert alpha.getpixel((10, 10)) == 0  # background gone
    assert alpha.getpixel((200, 200)) == 255  # white label inside the bottle kept
    assert alpha.getbbox() == pytest.approx((100, 50, 300, 350), abs=2)


def test_scene_goes_to_the_background_remover():
    im = Image.linear_gradient("L").resize((300, 300)).convert("RGB")
    buf = BytesIO()
    im.save(buf, "PNG")
    marker = Image.new("RGBA", (10, 10), (0, 0, 0, 255))
    assert cut_out(buf.getvalue(), remover=lambda data: marker) is marker


def test_large_picture_is_scaled_down_into_the_box_and_centred():
    c = compose(cut_out(picture(size=(2000, 2000), box=(0.3, 0.1, 0.7, 0.9))), layout())
    assert (c.width, c.height) == (1080, 1080)
    assert c.bottle[1] == int(1080 * 0.8) and c.scaled < 1 and not c.warnings
    bbox = Image.eval(opened(c).convert("L"), lambda v: 255 if v < 128 else 0).getbbox()
    assert abs((bbox[0] + bbox[2]) / 2 - 540) <= 2 and abs((bbox[1] + bbox[3]) / 2 - 540) <= 2
    assert opened(c).getpixel((5, 5)) == (255, 255, 255)


def test_small_picture_is_never_upscaled():
    c = compose(cut_out(picture(size=(400, 400), box=(0.3, 0.1, 0.7, 0.9))), layout())
    assert c.scaled == 1.0 and c.bottle == (160, 320)
    assert c.warnings and "не се уголемява" in c.warnings[0]


def test_bottom_anchor_and_jpeg_format():
    c = compose(cut_out(picture()), layout(anchor="bottom", bottom_margin=0.1, format="jpg"))
    assert c.extension == "jpg"
    bbox = Image.eval(opened(c).convert("L"), lambda v: 255 if v < 128 else 0).getbbox()
    assert abs(bbox[3] - 1080 * 0.9) <= 2


def test_cropped_source_is_flagged():
    data = picture(box=(0.3, 0.0, 0.7, 0.9))  # the bottle touches the top edge
    assert touches_edge(cut_out(data))
    out = compose_for_stores(data, GROUP, ["premierparfums", "parfemija"])
    assert out["premierparfums"] is out["parfemija"]
    assert any("опира" in w for w in out["premierparfums"].warnings)


@pytest.mark.rembg
def test_real_background_removal_model():
    im = Image.linear_gradient("L").resize((400, 400)).convert("RGB")
    ImageDraw.Draw(im).ellipse((120, 60, 280, 340), fill=(200, 30, 30))
    buf = BytesIO()
    im.save(buf, "PNG")
    cut = cut_out(buf.getvalue())
    assert cut.split()[3].getbbox() is not None
