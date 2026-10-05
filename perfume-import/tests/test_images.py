from pipeline.images import FetchError, best, check_all, image_field
from tests.conftest import png

DEAD = "https://www.giorgioarmanibeauty-usa.com/a.jpg"
BIG = "https://www.giorgioarmanibeauty-usa.com/3614270581656.png"
SMALL = "https://media.theperfumeshop.com/x-420x420.jpg"


def fake(pictures: dict):
    def fetch(url):
        result = pictures[url]
        if isinstance(result, Exception):
            raise result
        return result

    return fetch


def candidates(*urls):
    return [{"url": u, "width": 1200, "height": 1200, "source": "https://brand.com/p"} for u in urls]


def test_dead_first_link_is_skipped_and_the_largest_working_one_wins():
    fetch = fake({DEAD: FetchError("HTTP 404"), SMALL: png(420, 420), BIG: png(2400, 2400)})
    checked = check_all(candidates(DEAD, SMALL, BIG), fetch)
    assert [c.error for c in checked] == ["HTTP 404", None, None]
    assert (checked[1].width, checked[1].height) == (420, 420)  # measured, not what the model claimed
    assert best(checked).url == BIG
    f = image_field(checked, 1000)
    assert (f.value, f.status) == (BIG, "suggested")
    assert "2400×2400" in f.message and "най-голямата от 3" in f.message
    assert len(f.sources) == 3 and f.sources[0]["error"] == "HTTP 404"


def test_only_a_small_picture_is_a_warning_and_kept():
    checked = check_all(candidates(SMALL), fake({SMALL: png(420, 420)}))
    f = image_field(checked, 1000)
    assert (f.value, f.status) == (SMALL, "warning")
    assert "под минимума 1000" in f.message


def test_nothing_downloads_is_blocked_with_reasons():
    checked = check_all(candidates(DEAD, SMALL), fake({DEAD: FetchError("HTTP 404"), SMALL: b"<html>"}))
    f = image_field(checked, 1000)
    assert (f.value, f.status) == ("", "blocked")
    assert "HTTP 404" in f.message and "не е снимка" in f.message


def test_no_candidates_is_blocked():
    assert image_field(check_all([]), 1000).status == "blocked"


def test_duplicate_urls_are_checked_once():
    calls = []

    def fetch(url):
        calls.append(url)
        return png(1500, 1500)

    assert len(check_all(candidates(BIG, BIG), fetch)) == 1 and calls == [BIG]
