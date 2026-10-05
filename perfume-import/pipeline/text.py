"""Small, deterministic text helpers shared by detection, building and validation."""

import html
import re
import unicodedata

CURLY = str.maketrans({"’": "'", "‘": "'", "‛": "'", "“": '"', "”": '"', "„": '"', "–": "-", "—": "-"})
TAG = re.compile(r"<[^>]+>")
ML = re.compile(r"(\d+(?:[.,]\d+)?)\s*ml\b", re.IGNORECASE)


def straight_quotes(s: str) -> str:
    return s.translate(CURLY)


def collapse_spaces(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def strip_html(markup: str) -> str:
    return collapse_spaces(html.unescape(TAG.sub(" ", markup or "")))


def ascii_fold(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def slugify(title: str) -> str:
    """Shopify-style handle: '&' becomes 'and', apostrophes vanish, everything else non-alnum is a dash."""
    s = ascii_fold(straight_quotes(title)).lower().replace("&", " and ").replace("'", "")
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def space_ml(s: str) -> str:
    """'100ml' / '100 ML' -> '100 ml'."""
    return ML.sub(lambda m: f"{m.group(1)} ml", s)


def format_ml(ml: float | int | str) -> str:
    value = float(str(ml).replace(",", "."))
    return str(int(value)) if value.is_integer() else str(value)


def levenshtein(a: str, b: str) -> int:
    """Optimal string alignment distance: an adjacent transposition ('Unsiex') counts as one edit."""
    if a == b:
        return 0
    rows = [list(range(len(b) + 1))]
    for i, ca in enumerate(a, 1):
        row = [i]
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            row.append(min(rows[-1][j] + 1, row[j - 1] + 1, rows[-1][j - 1] + cost))
            if i > 1 and j > 1 and ca == b[j - 2] and a[i - 2] == cb:
                row[j] = min(row[j], rows[-2][j - 2] + 1)
        rows.append(row)
    return rows[-1][-1]


def percentile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    k = min(len(sorted_values) - 1, max(0, round(p * (len(sorted_values) - 1))))
    return sorted_values[k]
