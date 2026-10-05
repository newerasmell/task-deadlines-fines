"""A new batch end to end (SPEC §1): input -> research -> generate -> build per store -> validate.

Research and the English master run once per product; each store language is generated once; every store
gets its own fields (deterministic ones from build.py) and is validated with the same rules as the audit.
"""

import copy
from collections import Counter
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from urllib.parse import urlparse

from pipeline.ai import Usage
from pipeline.build import ProductInput, build_store_fields, google_gender
from pipeline.config import Group
from pipeline.fields import SEVERITY, Field, worst
from pipeline.generate import NOTE_KEYS, Text, generate_texts, text_fields
from pipeline.input import InputRow
from pipeline.research import Research, from_saved, research_product
from pipeline.validate import Context, validate_batch, validate_product

MAX_PARALLEL = 10  # SPEC: one researcher per product, at most 10 at a time
SHARED = ("name", "concentration", "gender", "fragrance_family", "ingredients")


def image_message(image: dict) -> str:
    """Say where the picture comes from and how big it is: it may be a retailer's thumbnail, not a packshot."""
    host = urlparse(image["url"]).netloc.lower().removeprefix("www.")
    size = (
        f"{image['width']}×{image['height']} px" if image.get("width") and image.get("height") else "размер неизвестен"
    )
    return f"Снимка от {host} ({size}). Провери, че е официална; обработката е във Фаза 3."


@dataclass
class ProductResult:
    row: InputRow
    research: Research | None = None
    reused_research: bool = False
    master: Text | None = None
    texts: dict[str, Text] = field(default_factory=dict)
    stores: dict[str, dict[str, Field]] = field(default_factory=dict)
    usage: dict[str, dict] = field(default_factory=dict)  # step -> Usage.to_dict()

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
            "over_budget": [
                {"input": p.row.name, "cost_usd": p.cost_usd, "steps": {k: u["cost_usd"] for k, u in p.usage.items()}}
                for p in self.products
                if self.max_cost is not None and p.cost_usd > self.max_cost
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
        image = research.images[0]["url"] if research.images else ""
        fields["image"] = Field(
            "image",
            image,
            "ai_research",
            "suggested" if image else "blocked",
            sources=research.images[:3],
            message=image_message(research.images[0]) if image else "Не е намерена снимка.",
        )

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
) -> ProductResult:
    result = ProductResult(row=row)
    raw = None if refresh or not row.ean else saved_research(row.ean)
    if raw:
        result.research, result.reused_research = from_saved(raw), True
    else:
        result.research = research_product(client, row, group)
        result.usage["research"] = result.research.usage.to_dict()
    return result


def run_batch(
    client,
    rows: list[InputRow],
    group: Group,
    stores: list[str],
    name: str,
    saved_research: Callable[[str], dict | None] = lambda ean: None,
    refresh: bool = False,
    workers: int = MAX_PARALLEL,
    batch_texts: bool = False,
    max_cost: float | None = None,
) -> BatchResult:
    """Research every product (parallel, interactive: it needs web search), then all texts at once
    (English masters in one round, every product x language in the next; one Message Batch per round
    when batch_texts=True, at half price)."""
    with ThreadPoolExecutor(max_workers=max(1, min(workers, MAX_PARALLEL))) as pool:
        products = list(pool.map(lambda r: research_step(client, r, group, saved_research, refresh), rows))

    ready = [p for p in products if not p.research.error]
    languages = [group.store(s).language for s in stores]
    texts = generate_texts(
        client, [(facts_for_text(p.research), p.row.tester) for p in ready], group, languages, batch=batch_texts
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
