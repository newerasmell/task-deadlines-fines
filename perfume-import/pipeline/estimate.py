"""Expected cost of a batch before any paid call (scripts/new_batch.py --estimate and the New batch screen).

Per research tier: measured averages of earlier runs when the database has them, else the defaults below.
"""

from collections import Counter
from dataclasses import dataclass, field

from pipeline.batch import resolve_tier
from pipeline.config import Group
from pipeline.input import InputRow
from pipeline.tiers import TIERS, ceiling

# Per-step costs (USD) when there is no measured run of that tier yet.
DEFAULT_COSTS = {
    "economy": {"research": 0.07, "description_en": 0.002, "language": 0.004},  # Sonnet, search only, Batch
    "deep": {"research": 0.35, "description_en": 0.02, "language": 0.015},  # Opus, pages, interactive
}


def usd(amount: float) -> str:
    """$0.125 stays $0.125 (":.2f" would show $0.12); whole cents keep two decimals."""
    return f"${amount:.3f}".rstrip("0") if round(amount, 2) != amount else f"${amount:.2f}"


@dataclass
class TierEstimate:
    tier: str
    label: str
    products: int
    per_product: float
    limit: float
    ceiling: float
    measured: bool


@dataclass
class Estimate:
    products: int
    stores: int
    languages: list[str]
    total: float
    tiers: list[TierEstimate] = field(default_factory=list)
    own_texts: int = 0  # stores writing in their own style: one text each instead of a shared translation

    def to_dict(self) -> dict:
        return {
            "products": self.products,
            "stores": self.stores,
            "languages": self.languages,
            "own_texts": self.own_texts,
            "total": round(self.total, 4),
            "tiers": [t.__dict__ for t in self.tiers],
        }


def estimate(
    rows: list[InputRow],
    group: Group,
    stores: list[str],
    default_tier: str = "economy",
    deep_eans: set[str] = frozenset(),
    measured: dict[str, dict[str, float]] | None = None,
    max_cost: float | None = None,
    no_batch: bool = False,
    styled: set[str] | None = None,
) -> Estimate:
    """measured: {tier: {research, description_en, language}} from db.repo.measured_costs.
    styled: stores that get their own text (pipeline.generate.store_style), priced like one translation each."""
    own = [s for s in stores if s in (styled or set())]
    languages = sorted({group.store(s).language for s in stores if s not in own} - {"en"})
    counts = Counter(resolve_tier(r, default_tier, deep_eans).name for r in rows)
    out = Estimate(products=len(rows), stores=len(stores), languages=languages, total=0.0, own_texts=len(own))
    for name, n in counts.items():
        known = (measured or {}).get(name) or {}
        costs = {**DEFAULT_COSTS[name], **known}
        factor = 2 if no_batch and TIERS[name].text_batch else 1
        per_product = costs["research"] + factor * (
            costs["description_en"] + costs["language"] * (len(languages) + len(own))
        )
        limit = max_cost if max_cost is not None else TIERS[name].max_cost
        out.total += per_product * n
        out.tiers.append(
            TierEstimate(name, TIERS[name].label, n, round(per_product, 4), limit, ceiling(limit), bool(known))
        )
    return out
