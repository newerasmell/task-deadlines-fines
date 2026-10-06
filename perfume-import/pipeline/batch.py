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
from pipeline.compose import Composed, compose_for_stores
from pipeline.config import Group
from pipeline.fields import SEVERITY, Field, worst
from pipeline.generate import NOTE_KEYS, Text, generate_texts, text_fields
from pipeline.images import Checked, best, check_all, image_field
from pipeline.input import InputRow
from pipeline.research import EanCheck, Research, find_images, fragrantica_bottle, from_saved, research_product
from pipeline.tiers import DEFAULT_TIER, OVERRUN, TIERS, Tier, ceiling, tier
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
    skipped: dict[str, str] = field(default_factory=dict)  # step -> why it was not run (the cost ceiling)
    original: Checked | None = None  # the picture the finished images were made from
    composed: dict[str, Composed] = field(default_factory=dict)  # store -> finished image (shared per layout)
    compose_error: str | None = None

    @property
    def cost_usd(self) -> float:
        return round(sum(u["cost_usd"] for u in self.usage.values()), 4)

    @property
    def ceiling(self) -> float:
        return ceiling(self.max_cost if self.max_cost is not None else self.tier.max_cost)

    def affords(self, step: str, expected: float) -> bool:
        """Run a paid step only if the product stays within its ceiling (limit + 20%) afterwards."""
        if self.cost_usd + expected <= self.ceiling:
            return True
        self.skipped[step] = (
            f"Пропуснато: ${self.cost_usd:.3f} похарчени + ≈${expected:.3f} за тази стъпка минава тавана "
            f"${self.ceiling:.2f} (лимит + {OVERRUN:.0%})."
        )
        return False


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
            "skipped": [{"input": p.row.name, "steps": p.skipped} for p in self.products if p.skipped],
        }


def facts_for_text(research: Research) -> dict:
    """Only facts the research actually found; blocked or empty ones never reach the prose.

    research_mismatch blocks the whole product (e.g. the EAN is another size) and is carried on `name`;
    the name itself was still found, so it stays in the facts."""
    facts = {}
    for key in ("brand", "name", "concentration", "gender", "fragrance_family", *NOTE_KEYS):
        f = research.fields.get(key)
        if f and not _value_blocked(f) and f.value not in (None, "", []):
            facts[key] = f.value
    return facts


def _value_blocked(f: Field) -> bool:
    if f.status != "blocked":
        return False
    rules = [i["rule"] for i in f.issues if i["status"] == "blocked"]
    return not rules or any(r != "research_mismatch" for r in rules)


def store_fields(result: ProductResult, group: Group, store_key: str, profile: dict | None = None) -> dict[str, Field]:
    """profile: the store's accepted profile (title, handle, SKU formulas win over the group's)."""
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
    fields = build_store_fields(item, group, store_key, profile)
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
        if "image_search" in result.skipped and fields["image"].status == "blocked":
            fields["image"].message += " Търсене на снимка: " + result.skipped["image_search"]
        image_composed(fields["image"], result.composed.get(store_key), result.compose_error)
        if research.ean_check:
            flag_ean(fields["ean"], research.ean_check, row)

    text = result.texts.get(store.language)
    if text and result.master:
        fields.update(text_fields(text, result.master, group))
    else:
        why = result.skipped.get("texts", "")
        fields["body_html"] = Field(
            "body_html", "", "ai_generated", "blocked", message=f"Описанието не е генерирано. {why}".strip()
        )
    fields["compare_at"] = Field("compare_at", "", "input", "ok")
    validate_product(fields, Context(group, store))
    return fields


def image_composed(f: Field, composed: Composed | None, error: str | None = None) -> None:
    """The finished picture for this store (SPEC §6). Until the batch is saved the value is still the source URL;
    db.repo.save_batch stores the files and points the value at the finished one."""
    if f.status == "blocked":
        return
    if error:
        f.flag("warning", f"Снимката не е сглобена: {error} Остава оригиналът.", "image_compose")
        return
    if composed is None:
        return
    f.message = (
        f"{f.message} Сглобена върху фона на магазина: {composed.width}×{composed.height} px, "
        f"шише {composed.bottle[0]}×{composed.bottle[1]} px"
        f"{'' if composed.scaled >= 1 else f' (смалено до {composed.scaled:.0%})'}."
    )
    for warning in composed.warnings:
        f.flag("warning", warning, "image_compose")


def compose_step(result: ProductResult, group: Group, stores: list[str]) -> None:
    """Cut out the best downloaded picture and place it on each layout. No AI, no cost."""
    result.original = best(result.images)
    if result.original is None or result.original.data is None:
        return
    try:
        result.composed = compose_for_stores(result.original.data, group, stores)
    except FileNotFoundError as exc:  # the group has no layout yet
        result.compose_error = str(exc)
    except Exception as exc:  # one bad picture must not stop the batch
        result.compose_error = f"{type(exc).__name__}: {exc}"


def flag_ean(f: Field, check: EanCheck, row: InputRow) -> None:
    """The input EAN stays (SKU, title and the rest are built from it); the app shows the sourced EAN for this
    volume as the alternative to accept. suggested, so nothing uploads until a person decides."""
    volume = f"{row.ml:g} ml" if row.ml else "този обем"
    found = check.suggestion
    f.sources = found.sources
    if found.value and found.value != f.value:
        f.alternatives = [found.value]
        f.confidence = found.confidence
        f.flag(
            "suggested",
            f"EAN {f.value} не е за този продукт/обем: {check.problem} За {volume} източниците дават {found.value}"
            f"{'' if found.status == 'ok' else ' (само един източник, провери)'}. Приеми го или остави входния.",
            "ean_mismatch",
        )
    else:
        f.flag(
            "suggested",
            f"EAN {f.value} не е за този продукт/обем: {check.problem} EAN за {volume} не е намерен; провери ръчно.",
            "ean_mismatch",
        )


def research_step(
    client,
    row: InputRow,
    group: Group,
    saved_research: Callable[[str], dict | None] = lambda ean: None,
    refresh: bool = False,
    fetch_image: Callable[[str], bytes] | None = None,
    tier: Tier | None = None,
    max_cost: float | None = None,
    texts: int = 1,
) -> ProductResult:
    """texts: how many texts this product still needs (English + translations); their expected cost is kept
    in reserve, so the optional image lookup never eats the budget for the description."""
    tier = tier or TIERS[DEFAULT_TIER]
    result = ProductResult(row=row, tier=tier, max_cost=max_cost if max_cost is not None else tier.max_cost)
    raw = None if refresh or not row.ean else saved_research(row.ean)
    if raw and not good_enough(raw, tier):
        raw = None  # saved economy research does not satisfy a deep request
    if raw:
        result.research, result.reused_research = from_saved(raw), True
    else:
        result.research = research_product(client, row, group, tier, budget=result.ceiling)
        result.research.raw["_tier"] = tier.name
        result.usage["research"] = result.research.usage.to_dict()
    if not result.research.error:
        result.images = check_all(result.research.images, fetch_image)
        min_height = group.spec.rules.image_min_height
        if (
            tier.image_search
            and not any(c.ok and c.height >= min_height for c in result.images)
            and result.affords("image_search", tier.image_search_cost + texts * tier.text_cost)
        ):
            extra, usage, error = find_images(client, row, result.research)
            result.usage["image_search"] = usage.to_dict()
            known = {c.url for c in result.images}
            extra = [i for i in extra if i["url"] not in known]
            result.images += check_all(extra, fetch_image)
            result.research.images = result.research.images + extra
            result.research.raw["images"] = result.research.images  # saved research keeps the found pictures
            if error:
                result.research.raw["_image_search_error"] = error
        if not any(c.ok for c in result.images):
            known = {c.url for c in result.images}
            extra = [i for i in fragrantica_bottle(result.research) if i["url"] not in known]
            result.images += check_all(extra, fetch_image)
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
    profiles: dict[str, dict] | None = None,
) -> BatchResult:
    """Research every product (parallel, interactive: it needs web search), then all texts at once
    (English masters in one round, every product x language in the next). Each product has a tier
    (resolve_tier): economy texts go through one Message Batch per round, deep texts are interactive.
    batch_texts=True/False forces all texts one way. max_cost overrides every tier's own limit.
    profiles: accepted store profiles by store key (db.stores.accepted_profiles); a store without one uses the
    group's formulas."""
    tiers = [resolve_tier(r, default_tier, deep_eans) for r in rows]
    languages = [group.store(s).language for s in stores]
    n_texts = 1 + len(set(languages) - {"en"})
    with ThreadPoolExecutor(max_workers=max(1, min(workers, MAX_PARALLEL))) as pool:
        products = list(
            pool.map(
                lambda rt: research_step(
                    client, rt[0], group, saved_research, refresh, fetch_image, rt[1], max_cost, n_texts
                ),
                zip(rows, tiers, strict=True),
            )
        )

        list(pool.map(lambda p: compose_step(p, group, stores), products))

    ready = [p for p in products if not p.research.error and p.affords("texts", n_texts * p.tier.text_cost)]
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
            p.stores[store] = store_fields(p, group, store, (profiles or {}).get(store))
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
