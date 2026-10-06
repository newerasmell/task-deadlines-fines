"""A new batch end to end (SPEC §1): input -> research -> generate -> build per store -> validate.

Research and the English master run once per product; each store language is generated once; every store
gets its own fields (deterministic ones from build.py) and is validated with the same rules as the audit.
"""

import copy
from collections import Counter
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field

from pipeline.ai import Usage
from pipeline.build import ProductInput, build_store_fields, google_gender
from pipeline.config import Group
from pipeline.fields import SEVERITY, Field, worst
from pipeline.generate import NOTE_KEYS, Text, generate_texts, text_fields
from pipeline.images import Checked, check_all, image_field
from pipeline.input import InputRow
from pipeline.research import Research, find_images, from_saved, research_product
from pipeline.tiers import DEFAULT_TIER, TIERS, Tier, tier
from pipeline.validate import Context, validate_batch, validate_product

MAX_PARALLEL = 10  # SPEC: one researcher per product, at most 10 at a time
SHARED = ("name", "concentration", "gender", "fragrance_family", "ingredients")


@dataclass
class ProductResult:
    row: InputRow
    research: Research | None = None
    reused_research: bool = False
    master: Text | None = None
    texts: dict[str, Text] = field(default_factory=dict)
    stores: dict[str, dict[str, Field]] = field(default_factory=dict)
    usage: dict[str, dict] = field(default_factory=dict)  # step -> Usage.to_dict()
    images: list[Checked] = field(default_factory=list)  # downloaded and measured, shared by all stores
    tier: Tier = field(default_factory=lambda: TIERS[DEFAULT_TIER])
    max_cost: float | None = None

    @property
    def cost_usd(self) -> float:
        return round(sum(u["cost_usd"] for u in self.usage.values()), 4)


@dataclass
class BatchResult:
    name: str
    group: str
    stores: list[str]
    products: list[ProductResult]
    max_cost: float | None = None

    @property
    def cost_usd(self) -> float:
        return round(sum(p.cost_usd for p in self.products), 4)

    def summary(self) -> dict:
        out = {}
        for store in self.stores:
            by_product = Counter(worst(list(p.stores[store].values())) for p in self.products)
            by_field = Counter(f.status for p in self.products for f in p.stores[store].values())
            out[store] = {
                "products": {s: by_product.get(s, 0) for s in SEVERITY},
                "fields": {s: by_field.get(s, 0) for s in SEVERITY},
            }
        return {
            "name": self.name,
            "group": self.group,
            "products": len(self.products),
            "stores": out,
            "cost_usd": self.cost_usd,
            "cost_per_product_usd": round(self.cost_usd / max(1, len(self.products)), 4),
            "max_cost_usd": self.max_cost,
            "tiers": dict(Counter(p.tier.name for p in self.products)),
            "over_budget": [
                {
                    "input": p.row.name,
                    "tier": p.tier.name,
                    "limit_usd": p.max_cost,
                    "cost_usd": p.cost_usd,
                    "steps": {k: u["cost_usd"] for k, u in p.usage.items()},
                }
                for p in self.products
                if p.max_cost is not None and p.cost_usd > p.max_cost
            ],
        }


def facts_for_text(research: Research) -> dict:
    """Only facts the research actually found; blocked or empty ones never reach the prose."""
    facts = {}
    for key in ("brand", "name", "concentration", "gender", "fragrance_family", *NOTE_KEYS):
        f = research.fields.get(key)
        if f and f.status != "blocked" and f.value not in (None, "", []):
            facts[key] = f.value
    return facts


def store_fields(result: ProductResult, group: Group, store_key: str) -> dict[str, Field]:
    row, research = result.row, result.research
    store = group.store(store_key)
    brand = research.value("brand") if research else None
    name = research.value("name") if research else None
    item = ProductInput(
        brand=brand or "",
        name=name or row.name,
        concentration=research.value("concentration") if research else None,
        ml=row.ml or 0,
        tester=row.tester,
        ean=row.ean,
        prices=row.prices,
    )
    fields = build_store_fields(item, group, store_key)
    if not brand or not name:
        fields["title"].flag(
            "blocked", "Проучването не намери марка и име; заглавието не може да се сглоби.", "title_parts"
        )
    if row.ml is None:
        fields["title"].flag("blocked", "Липсва обем (ml) във входа.", "input_ml")
    for problem in row.problems:
        fields["title"].flag("blocked", f"Вход, {row.label}: {problem}", "input")

    if research:
        if "brand" in research.fields:
            fields["vendor"] = copy.deepcopy(research.fields["brand"])
            fields["vendor"].key = "vendor"
        for key in SHARED:
            if key in research.fields:
                fields[key] = copy.deepcopy(research.fields[key])
        gender = research.value("gender")
        fields["google.gender"] = Field("google.gender", google_gender(gender, group), "template", "ok")
        fields["image"] = image_field(result.images, group.spec.rules.image_min_height)

    text = result.texts.get(store.language)
    if text and result.master:
        fields.update(text_fields(text, result.master, group))
    else:
        fields["body_html"] = Field("body_html", "", "ai_generated", "blocked", message="Описанието не е генерирано.")
    fields["compare_at"] = Field("compare_at", "", "input", "ok")
    validate_product(fields, Context(group, store))
    return fields


def research_step(
    client,
    row: InputRow,
    group: Group,
    saved_research: Callable[[str], dict | None] = lambda ean: None,
    refresh: bool = False,
    fetch_image: Callable[[str], bytes] | None = None,
    tier: Tier | None = None,
) -> ProductResult:
    tier = tier or TIERS[DEFAULT_TIER]
    result = ProductResult(row=row, tier=tier)
    raw = None if refresh or not row.ean else saved_research(row.ean)
    if raw and not good_enough(raw, tier):
        raw = None  # saved economy research does not satisfy a deep request
    if raw:
        result.research, result.reused_research = from_saved(raw), True
    else:
        result.research = research_product(client, row, group, tier)
        result.research.raw["_tier"] = tier.name
        result.usage["research"] = result.research.usage.to_dict()
    if not result.research.error:
        result.images = check_all(result.research.images, fetch_image)
        if tier.image_search and not any(c.ok for c in result.images):
            extra, usage, error = find_images(client, row, result.research)
            result.usage["image_search"] = usage.to_dict()
            known = {c.url for c in result.images}
            extra = [i for i in extra if i["url"] not in known]
            result.images += check_all(extra, fetch_image)
            result.research.images = result.research.images + extra
            result.research.raw["images"] = result.research.images  # saved research keeps the found pictures
            if error:
                result.research.raw["_image_search_error"] = error
    return result


def good_enough(raw: dict, tier: Tier) -> bool:
    order = list(TIERS)
    saved = raw.get("_tier", DEFAULT_TIER)
    return order.index(saved if saved in TIERS else DEFAULT_TIER) >= order.index(tier.name)


def resolve_tier(row: InputRow, default: str = DEFAULT_TIER, deep_eans: set[str] = frozenset()) -> Tier:
    """Most specific wins: the row's own `research` column, then --deep EANs, then the batch's tier."""
    if row.tier:
        return TIERS[row.tier]
    if row.ean and row.ean in deep_eans:
        return TIERS["deep"]
    return tier(default)


def run_batch(
    client,
    rows: list[InputRow],
    group: Group,
    stores: list[str],
    name: str,
    saved_research: Callable[[str], dict | None] = lambda ean: None,
    refresh: bool = False,
    workers: int = MAX_PARALLEL,
    batch_texts: bool | None = None,
    max_cost: float | None = None,
    fetch_image: Callable[[str], bytes] | None = None,
    default_tier: str = DEFAULT_TIER,
    deep_eans: set[str] = frozenset(),
) -> BatchResult:
    """Research every product (parallel, interactive: it needs web search), then all texts at once
    (English masters in one round, every product x language in the next). Each product has a tier
    (resolve_tier): economy texts go through one Message Batch per round, deep texts are interactive.
    batch_texts=True/False forces all texts one way. max_cost overrides every tier's own limit."""
    tiers = [resolve_tier(r, default_tier, deep_eans) for r in rows]
    with ThreadPoolExecutor(max_workers=max(1, min(workers, MAX_PARALLEL))) as pool:
        products = list(
            pool.map(
                lambda rt: research_step(client, rt[0], group, saved_research, refresh, fetch_image, rt[1]),
                zip(rows, tiers, strict=True),
            )
        )
    for p in products:
        p.max_cost = max_cost if max_cost is not None else p.tier.max_cost

    ready = [p for p in products if not p.research.error]
    languages = [group.store(s).language for s in stores]
    texts = generate_texts(
        client, [(facts_for_text(p.research), p.row.tester, p.tier) for p in ready], group, languages, batch=batch_texts
    )
    for p, (master, by_language) in zip(ready, texts, strict=True):
        p.master, p.texts = master, by_language
        p.usage["description_en"] = master.usage.to_dict()
        for language, t in by_language.items():
            if language != "en":
                p.usage[f"text_{language}"] = t.usage.to_dict()

    for p in products:
        for store in stores:
            p.stores[store] = store_fields(p, group, store)
    for store in stores:
        validate_batch([p.stores[store] for p in products])
    return BatchResult(name=name, group=group.key, stores=stores, products=products, max_cost=max_cost)


def row_dict(row: InputRow) -> dict:
    return asdict(row)


def usage_total(result: BatchResult) -> Usage:
    total = Usage()
    for p in result.products:
        for u in p.usage.values():
            total.add(Usage(**{k: v for k, v in u.items() if k != "cost_usd"}, cost=u["cost_usd"]))
    return total
