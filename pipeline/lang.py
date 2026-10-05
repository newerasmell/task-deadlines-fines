"""Language detection limited to the languages our stores use (accuracy is much better on a small set)."""

from collections import Counter
from functools import lru_cache

from lingua import Language, LanguageDetectorBuilder

LANGUAGES = {
    "en": Language.ENGLISH,
    "bg": Language.BULGARIAN,
    "el": Language.GREEK,
    "hr": Language.CROATIAN,
    "cs": Language.CZECH,
    "sk": Language.SLOVAK,
    "sl": Language.SLOVENE,
    "hu": Language.HUNGARIAN,
    "pl": Language.POLISH,
    "et": Language.ESTONIAN,
    "lt": Language.LITHUANIAN,
    "lv": Language.LATVIAN,
    "ro": Language.ROMANIAN,
    "de": Language.GERMAN,
}
CODE = {v: k for k, v in LANGUAGES.items()}
MIN_CHARS = 40  # below this a guess is not worth reporting


@lru_cache
def _detector():
    return LanguageDetectorBuilder.from_languages(*LANGUAGES.values()).build()


def detect(text: str, min_chars: int = MIN_CHARS) -> str | None:
    if len(text.strip()) < min_chars:
        return None
    found = _detector().detect_language_of(text)
    return CODE.get(found) if found else None


def dominant(texts: list[str]) -> tuple[str | None, float, Counter]:
    counts = Counter(code for t in texts if (code := detect(t)))
    if not counts:
        return None, 0.0, counts
    code, n = counts.most_common(1)[0]
    return code, n / sum(counts.values()), counts
