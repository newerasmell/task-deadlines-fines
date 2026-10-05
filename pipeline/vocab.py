"""Controlled vocabularies: learning them from an export, and matching values against a confirmed vocab.

Learning (detect_store) groups spellings of the same value into clusters, picks a canonical spelling, and
separates values written in another language. Matching (validate) maps a value to the confirmed canonical.
"""

import re
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from pipeline.text import levenshtein, straight_quotes

SEPARATORS = re.compile(r"(?:[\s\-_/,&+]|\band\b)+")


def strip_marks(s: str) -> str:
    """'Fougère' -> 'Fougere', 'Ανθινος' stays Greek (only combining marks are dropped)."""
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def raw_tokens(value: str) -> list[str]:
    s = strip_marks(straight_quotes(value)).casefold().strip()
    return [t for t in SEPARATORS.split(s) if t]


def is_latin(value: str) -> bool:
    letters = [c for c in value if c.isalpha()]
    return bool(letters) and all(unicodedata.name(c, "").startswith("LATIN") for c in letters)


def _close(a: str, b: str) -> bool:
    if a == b:
        return True
    # Same first letter keeps "men's" away from "women's"; short words only tolerate one typo.
    if min(len(a), len(b)) < 4 or a[0] != b[0]:
        return False
    return levenshtein(a, b) <= (1 if max(len(a), len(b)) < 9 else 2)


def _clean_form(value: str) -> str:
    words = straight_quotes(value).replace("-", " ").split()
    return " ".join(w[:1].upper() + w[1:] for w in words)


def _is_clean(value: str) -> bool:
    """Canonical-looking spelling: straight quotes, space separated, each word capitalised."""
    if value != straight_quotes(value) or value != value.strip() or "-" in value or "  " in value:
        return False
    return all(w[:1].isupper() for w in value.split())


@dataclass
class Cluster:
    key: tuple[str, ...]
    originals: Counter = field(default_factory=Counter)
    canonical: str = ""
    local: bool = False  # written in another language than the store's vocabulary
    maps_to: str | None = None  # for local clusters: canonical found through paired stores
    via: str | None = None
    paired: int = 0
    shared: int = 0

    @property
    def total(self) -> int:
        return sum(self.originals.values())


class LearnedVocab:
    """Vocabulary learned from the values of one controlled field in one export."""

    def __init__(self, values: Counter, min_count: int = 3):
        self.values = Counter({v: n for v, n in values.items() if v.strip()})
        self.empty = sum(n for v, n in values.items() if not v.strip())
        self.min_count = min_count
        total = sum(self.values.values()) or 1
        token_weight, in_compound = Counter(), Counter()
        for v, n in self.values.items():
            tokens = set(raw_tokens(v))
            for t in tokens:
                token_weight[t] += n
                if len(tokens) > 1:
                    in_compound[t] += n
        # A token that qualifies most values ("perfume" in "Women's Perfume") carries no meaning for grouping.
        # A value that simply dominates on its own ("Floral") is not such a token.
        self.stopwords = {t for t, n in token_weight.items() if n / total >= 0.5 and in_compound[t] / n >= 0.8}
        self.token_spread = Counter(t for v in self.values for t in set(raw_tokens(v)))
        self.dominant_latin = sum(n for v, n in self.values.items() if is_latin(v)) >= total / 2
        self.clusters: list[Cluster] = []
        self._by_value: dict[str, Cluster] = {}
        self._build()

    # ---- grouping -------------------------------------------------------------------------------
    def key(self, value: str) -> tuple[str, ...]:
        tokens = raw_tokens(value)
        kept = [t for t in tokens if not any(_close(t, s) for s in self.stopwords)]
        return tuple(sorted(kept or tokens))

    def _build(self) -> None:
        by_key: dict[tuple[str, ...], Cluster] = {}
        for v, n in self.values.items():
            k = self.key(v)
            by_key.setdefault(k, Cluster(k)).originals[v] += n
        clusters = sorted(by_key.values(), key=lambda c: -c.total)
        merged: list[Cluster] = []
        for c in clusters:
            target = next((b for b in merged if self._fuzzy_same(c.key, b.key)), None)
            if target:
                target.originals.update(c.originals)
            else:
                merged.append(c)
        for c in merged:
            c.canonical = self._pick_canonical(c)
            if not self.dominant_latin == is_latin(c.canonical):
                c.local = True
            for v in c.originals:
                self._by_value[v] = c
        self.clusters = sorted(merged, key=lambda c: -c.total)

    @staticmethod
    def _fuzzy_same(a: tuple[str, ...], b: tuple[str, ...]) -> bool:
        if a == b:
            return True
        if len(a) != len(b):
            # "Unisex" vs "Unisex Perfume" is handled by stopwords; anything else stays apart.
            return False
        return all(_close(x, y) for x, y in zip(a, b, strict=True))

    def _pick_canonical(self, c: Cluster) -> str:
        def score(v: str):
            spread = sum(self.token_spread[t] for t in raw_tokens(v))
            return (spread, _is_clean(v), c.originals[v], v)

        best = max(c.originals, key=score)
        return best if _is_clean(best) else _clean_form(best)

    def lookup(self, value: str) -> Cluster | None:
        if value in self._by_value:
            return self._by_value[value]
        k = self.key(value)
        for c in self.clusters:
            if self._fuzzy_same(k, c.key):
                return c
        return None

    # ---- other stores ---------------------------------------------------------------------------
    def apply_pairs(self, pairs: list[tuple[str, str]], reference: "LearnedVocab") -> None:
        """pairs = (value here, value of the same product in a reference store).

        A cluster is a local translation when the same products carry a different value of this store's
        vocabulary in the reference store, or (no such evidence) when the reference never uses it at all.
        It is then mapped to the canonical its partners point to, directly or one hop through the reference.
        """
        partners: dict[int, Counter] = defaultdict(Counter)
        back: dict[str, Counter] = defaultdict(Counter)  # reference value -> values here
        for own, ref in pairs:
            if not own.strip() or not ref.strip():
                continue
            c = self.lookup(own)
            if c is None:
                continue
            if self.lookup(ref) is not None:  # partner is a value this store also uses
                c.paired += 1
                c.shared += self.lookup(ref) is c
            partners[id(c)][ref] += 1
            back[ref][own] += 1
        for c in self.clusters:
            if c.paired:
                c.local = c.local or c.shared / c.paired < 0.5
            elif partners[id(c)]:
                c.local = c.local or reference.lookup(c.canonical) is None
        for c in self.clusters:
            if not c.local:
                continue
            direct, hop = Counter(), Counter()
            for ref, n in partners[id(c)].items():
                target = self.lookup(ref)
                if target is not None and not target.local:
                    direct[target.canonical] += n
                if target is not None:
                    continue  # only hop through reference values this store does not use itself
                for own2, m in back[ref].items():
                    t2 = self.lookup(own2)
                    if t2 is not None and not t2.local and t2 is not c:
                        hop[t2.canonical] += m
            for found, via in ((direct, "pair"), (hop, "pair_hop")):
                if found:
                    best, n = found.most_common(1)[0]
                    if n >= 2 and n / sum(found.values()) >= 0.6:
                        c.maps_to, c.via = best, via
                        break

    # ---- output ---------------------------------------------------------------------------------
    @property
    def canonical(self) -> list[Cluster]:
        return [c for c in self.clusters if not c.local and c.total >= self.min_count]

    def as_profile(self) -> dict:
        canonical = {c.canonical: c for c in self.canonical}
        filled = sum(self.values.values())
        in_vocab = sum(c.total for c in canonical.values())
        mapped_local = [c for c in self.clusters if c.local and c.maps_to in canonical]
        exact = sum(c.originals[c.canonical] for c in canonical.values())
        return {
            "canonical": {
                name: {
                    "count": c.total,
                    "variants": {v: n for v, n in c.originals.most_common() if v != name},
                }
                for name, c in canonical.items()
            },
            "translations": {
                v: {"count": n, "maps_to": c.maps_to, "via": c.via}
                for c in self.clusters
                if c.local
                for v, n in c.originals.most_common()
            },
            "long_tail": {
                c.canonical: dict(c.originals.most_common())
                for c in self.clusters
                if not c.local and c.total < self.min_count
            },
            "stopwords": sorted(self.stopwords),
            "filled": filled,
            "empty": self.empty,
            # share of filled values already spelled exactly as their canonical
            "exact_rate": round(exact / filled, 3) if filled else 0.0,
            # share of filled values that resolve to a canonical (spelling variant or mapped translation)
            "resolved_rate": round((in_vocab + sum(c.total for c in mapped_local)) / filled, 3) if filled else 0.0,
        }


class VocabMatcher:
    """Matches values against a confirmed vocab (vocab.yaml: canonical -> known variants)."""

    def __init__(self, vocab: dict[str, list[str]]):
        self.canonicals = list(vocab)
        self.variants = {v: c for c, vs in vocab.items() for v in vs}
        token_count = Counter(t for c in self.canonicals for t in set(raw_tokens(c)))
        self.stopwords = {t for t, n in token_count.items() if n / max(1, len(self.canonicals)) >= 0.5}
        self.keys: dict[tuple[str, ...], str] = {}
        for c in self.canonicals:
            self.keys.setdefault(self._key(c), c)
        for v, c in self.variants.items():
            self.keys.setdefault(self._key(v), c)

    def _key(self, value: str) -> tuple[str, ...]:
        tokens = raw_tokens(value)
        kept = [t for t in tokens if not any(_close(t, s) for s in self.stopwords)]
        return tuple(sorted(kept or tokens))

    def match(self, value: str) -> tuple[str | None, str]:
        """-> (canonical, how): how is exact | variant | normalized | fuzzy | none."""
        if value in self.canonicals:
            return value, "exact"
        if value in self.variants:
            return self.variants[value], "variant"
        k = self._key(value)
        if k in self.keys:
            return self.keys[k], "normalized"
        for key, canonical in self.keys.items():
            if LearnedVocab._fuzzy_same(k, key):
                return canonical, "fuzzy"
        return None, "none"
