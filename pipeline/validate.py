"""Validation rules (SPEC §7). Runs after build and before upload, and standalone on a store export (audit).

Rules mutate Field records in place: auto_fix keeps the old value in `previous`; everything else raises the
status (never lowers it) with a Bulgarian message saying what is wrong and how to fix it.
Rules that need the AI (regenerate a description) or the image pipeline (resolution) arrive in phases 2-3;
until then those findings stay warnings.
"""

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from pipeline import ean, lang
from pipeline.config import Group, StoreConfig
from pipeline.export import Export
from pipeline.fields import SEVERITY, Field, worst
from pipeline.text import collapse_spaces, space_ml, strip_html
from pipeline.titles import parse_title, render
from pipeline.vocab import VocabMatcher, is_latin

CONTROLLED = ("gender", "fragrance_family")
NOTES = ("top_note", "middle_note", "base_note")
SPACED_TEXT = ("title", "vendor", "seo_title", *CONTROLLED, *NOTES, "product_milliliters", "product_type")
WITH_ML = ("title", "product_milliliters")


@dataclass
class Context:
    group: Group
    store: StoreConfig
    matchers: dict[str, VocabMatcher] = field(init=False)

    def __post_init__(self) -> None:
        self.matchers = {k: VocabMatcher(v) for k, v in self.group.vocab.items()}

    @property
    def spec(self):
        return self.group.spec

    @property
    def title_shape(self) -> str:
        return self.spec.title.split("{tester")[0]


# ---- single product --------------------------------------------------------------------------------


def validate_product(fields: dict[str, Field], ctx: Context) -> None:
    _formatting(fields)
    _controlled(fields, ctx)
    _ean_and_sku(fields, ctx)
    _title(fields, ctx)
    _language(fields, ctx)
    _description(fields, ctx)
    _prices(fields, ctx)
    _image(fields)


def _formatting(fields: dict[str, Field]) -> None:
    for key in SPACED_TEXT:
        f = fields.get(key)
        if f is None or not isinstance(f.value, str) or not f.value:
            continue
        fixed = collapse_spaces(f.value)
        if key in WITH_ML:
            fixed = space_ml(fixed)
        if fixed != f.value:
            f.fix(fixed, f"Форматиране: „{f.value}“ → „{fixed}“.", "format")


def _controlled(fields: dict[str, Field], ctx: Context) -> None:
    for key in CONTROLLED:
        f, matcher = fields.get(key), ctx.matchers.get(key)
        if f is None or matcher is None:
            continue
        if not (f.value or "").strip():
            f.flag("warning", "Полето е празно. Избери стойност от речника.", f"{key}_empty")
            continue
        canonical, how = matcher.match(f.value)
        if how == "exact":
            continue
        if canonical:
            f.fix(canonical, f"„{f.value}“ е вариант на „{canonical}“ (речник).", f"{key}_variant")
        else:
            f.alternatives = matcher.canonicals
            f.flag(
                "warning",
                f"„{f.value}“ не е в речника за {key}. Избери от списъка или добави като вариант във vocab.yaml.",
                f"{key}_unknown",
            )


def _ean_and_sku(fields: dict[str, Field], ctx: Context) -> None:
    code_field = fields["ean"]
    code = ean.clean(code_field.value)
    if not code:
        found = [c for c in _ean_candidates(fields) if ean.is_valid(c)]
        if found:
            code_field.alternatives = found
            code_field.flag(
                "blocked",
                f"Полето за EAN е празно, но {found[0]} (валиден EAN) стои в SKU/баркода. Потвърди го и го попълни.",
                "ean_in_other_field",
            )
        else:
            code_field.flag("blocked", "Липсва EAN. Въведи го от опаковката.", "ean_missing")
    elif problem := ean.problem(code):
        code_field.flag("blocked", problem, "ean_invalid")
    elif code != code_field.value:
        code_field.fix(code, f"Почистен EAN: „{code_field.value}“ → „{code}“.", "ean_format")

    sku = fields["sku"]
    raw = (sku.value or "").strip()
    if not raw or raw.upper() == "NAN":
        sku.flag("blocked", "Липсва SKU.", "sku_missing")
        return
    if ean.is_valid(code):
        expected = render(ctx.spec.sku, {"ean": code})
        if raw != expected:
            sku.alternatives = [expected]
            sku.flag("warning", f"SKU „{raw}“ не следва {ctx.spec.sku}; очаквано „{expected}“.", "sku_formula")


def _ean_candidates(fields: dict[str, Field]) -> list[str]:
    out = []
    sku = ean.clean((fields.get("sku") or Field("sku", "", "input", "ok")).value)
    if m := re.fullmatch(r"[A-Za-z]*(\d+)[A-Za-z]*", sku):
        out.append(m.group(1))
    if barcode := fields.get("barcode"):
        out.append(ean.clean(barcode.value))
    return [c for c in dict.fromkeys(out) if c]


def _title(fields: dict[str, Field], ctx: Context) -> None:
    title = fields["title"]
    parsed = parse_title(title.value or "", (fields.get("vendor") or Field("vendor", "", "input", "ok")).value or "")
    marker = ctx.spec.title.split("'")[1].strip() if "{tester:" in ctx.spec.title else None
    if marker and parsed.tester and parsed.tester != marker:
        fixed = title.value[: -len(parsed.tester)] + marker
        title.fix(fixed, f"Маркерът за тестер е „{marker}“: „{title.value}“ → „{fixed}“.", "tester_marker")
    if parsed.ml is None:
        title.flag(
            "warning",
            "В заглавието няма обем (напр. „100 ml“). Провери дали това е реален продукт.",
            "title_no_ml",
        )
    elif parsed.shape != ctx.title_shape.strip():
        title.flag("warning", f"Заглавието не следва {ctx.spec.title}.", "title_formula")
    ml_field = fields.get("product_milliliters")
    if parsed.ml and ml_field and ml_field.value:
        ml_value = space_ml(collapse_spaces(ml_field.value))
        if ml_value != f"{parsed.ml} ml":
            ml_field.flag(
                "warning",
                f"Обемът в заглавието е {parsed.ml} ml, а в полето {ml_field.value}.",
                "ml_mismatch",
            )


def _language(fields: dict[str, Field], ctx: Context) -> None:
    store_lang = ctx.store.language
    body = fields.get("body_html")
    if body and body.value:
        found = lang.detect(strip_html(body.value))
        if found and found != store_lang:
            body.flag(
                "warning",
                f"Описанието е на „{found}“, а магазинът е на „{store_lang}“. Регенерирането идва във Фаза 2.",
                "language_body",
            )
    expect_latin = store_lang not in ("el", "bg")
    for key in NOTES:
        f = fields.get(key)
        if not f or not f.value or len(f.value) < 3:
            continue
        found = lang.detect(f.value, min_chars=12)
        wrong_script = is_latin(f.value) != expect_latin
        if (found == "en" and store_lang != "en") or wrong_script:
            what = "на английски" if found == "en" else ("на латиница" if is_latin(f.value) else "на друга азбука")
            f.flag(
                "warning",
                f"Нотите „{f.value[:40]}“ са {what}, а магазинът е на „{store_lang}“. Преводът идва във Фаза 2.",
                "language_notes",
            )


def _description(fields: dict[str, Field], ctx: Context) -> None:
    body = fields.get("body_html")
    if body is None:
        return
    text = strip_html(body.value or "")
    if not text:
        body.flag("warning", "Липсва описание.", "description_missing")
        return
    lo, hi = ctx.spec.description.length
    if not lo <= len(text) <= hi:
        body.flag(
            "warning",
            f"Описанието е {len(text)} знака; групата иска {lo}–{hi}.",
            "description_length",
        )
    parsed = parse_title(fields["title"].value or "")
    if parsed.tester:
        rest = text.replace(fields["title"].previous or fields["title"].value or "", "")
        rest = rest.replace(fields["title"].value or "", "")
        if parsed.tester.casefold() not in rest.casefold():
            body.flag(
                "warning",
                "Тестер без изречение, че е същият аромат в по-проста опаковка (description.md).",
                "tester_sentence",
            )


def _money(value) -> float | None:
    try:
        return float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None


def _prices(fields: dict[str, Field], ctx: Context) -> None:
    price_field = fields.get("price")
    if price_field is None:
        return
    price = _money(price_field.value)
    if price is None or price <= 0:
        price_field.flag("blocked", f"Липсва цена за {ctx.store.label}.", "price_missing")
        return
    compare_field = fields.get("compare_at")
    compare = _money(compare_field.value) if compare_field else None
    if compare is None:
        return
    if compare <= price:
        compare_field.flag(
            "blocked",
            f"Старата цена {compare:.2f} не е по-висока от цената {price:.2f}.",
            "compare_at_not_above",
        )
        return
    lo, hi = ctx.spec.rules.compare_at_ratio
    ratio = compare / price
    if not lo <= ratio <= hi:
        compare_field.flag(
            "blocked",
            f"Старата цена е {ratio:.2f}× цената; групата допуска {lo}–{hi}×.",
            "compare_at_ratio",
        )


def _image(fields: dict[str, Field]) -> None:
    image = fields.get("image")
    if image is not None and not (image.value or "").strip():
        image.flag("blocked", "Продуктът няма снимка.", "image_missing")


# ---- batch -----------------------------------------------------------------------------------------


def validate_batch(
    products: list[dict[str, Field]],
    existing_skus: set[str] = frozenset(),
    existing_handles: set[str] = frozenset(),
) -> None:
    """Duplicate SKU or handle in the batch or already in the store -> blocked (every occurrence)."""
    for key, existing in (("sku", existing_skus), ("handle", existing_handles)):
        counts = Counter(_dup_key(p[key].value) for p in products if p.get(key) and _dup_key(p[key].value))
        for p in products:
            k = _dup_key(p[key].value) if p.get(key) else ""
            if not k:
                continue
            if counts[k] > 1:
                p[key].flag(
                    "blocked",
                    f"{key.upper()} „{p[key].value}“ се повтаря {counts[k]} пъти.",
                    f"{key}_duplicate",
                )
            elif k in existing:
                p[key].flag("blocked", f"{key.upper()} „{p[key].value}“ вече съществува в магазина.", f"{key}_exists")


def _dup_key(value) -> str:
    v = ean.clean(value or "").upper()
    return "" if v in ("", "NAN") else v


# ---- audit of an export ----------------------------------------------------------------------------


def fields_from_export(p: dict, export: Export, ctx: Context) -> dict[str, Field]:
    def f(key, value):
        return Field(key=key, value=value, origin="input", status="ok")

    def mf(key):
        col = export.metafield_column(key)
        return p.get(col, "") if col else None

    ean_key = next((k for k, v in ctx.spec.metafields.items() if v == "{ean}"), None)
    out = {
        "title": f("title", p.get("Title", "")),
        "handle": f("handle", p.get("Handle", "")),
        "sku": f("sku", p.get("Variant SKU", "")),
        "ean": f("ean", mf(ean_key) if ean_key else p.get("Variant Barcodes", "")),
        "vendor": f("vendor", p.get("Vendor", "")),
        "body_html": f("body_html", p.get("Body (HTML)", "")),
        "seo_title": f("seo_title", p.get("SEO Title", "")),
        "seo_description": f("seo_description", p.get("SEO Description", "")),
        "price": f("price", p.get("Variant Price", "")),
        "compare_at": f("compare_at", p.get("Variant Compare At Price", "")),
        "image": f("image", p.get("Image Src", "")),
    }
    if ean_key:
        out["barcode"] = f("barcode", p.get("Variant Barcodes", ""))
    for key in (*CONTROLLED, *NOTES, "ingredients", "product_milliliters", "product_type"):
        value = mf(key)
        if value is not None:
            out[key] = f(key, value)
    return out


@dataclass
class AuditProduct:
    handle: str
    title: str
    fields: dict[str, Field]

    @property
    def status(self) -> str:
        return worst(list(self.fields.values()))


@dataclass
class AuditReport:
    store: str
    group: str
    source: str
    products: list[AuditProduct]

    def summary(self) -> dict:
        by_product = Counter(p.status for p in self.products)
        by_field = Counter(f.status for p in self.products for f in p.fields.values())
        rules: dict[str, dict] = defaultdict(lambda: {"count": 0, "status": "ok", "examples": []})
        for p in self.products:
            for f in p.fields.values():
                for issue in f.issues:
                    r = rules[issue["rule"]]
                    r["count"] += 1
                    r["status"] = max(r["status"], issue["status"], key=SEVERITY.__getitem__)
                    if len(r["examples"]) < 5:
                        r["examples"].append({"title": p.title, "field": f.key, "message": issue["message"]})
        order = sorted(rules.items(), key=lambda kv: (-SEVERITY[kv[1]["status"]], -kv[1]["count"]))
        return {
            "store": self.store,
            "group": self.group,
            "source": self.source,
            "products": len(self.products),
            "products_by_status": {s: by_product.get(s, 0) for s in SEVERITY},
            "fields_by_status": {s: by_field.get(s, 0) for s in SEVERITY},
            "rules": dict(order),
        }

    def findings(self) -> list[dict]:
        """One row per issue, so a field with two problems shows both."""
        rows = []
        for p in self.products:
            for f in p.fields.values():
                for issue in f.issues:
                    rows.append(
                        {
                            "handle": p.handle,
                            "title": p.title,
                            "field": f.key,
                            "status": issue["status"],
                            "rule": issue["rule"],
                            "value": f.previous if f.previous is not None else f.value,
                            "fixed_value": f.value if f.origin == "auto_fix" else "",
                            "message": issue["message"],
                        }
                    )
        return rows


def audit(export: Export, group: Group, store_key: str) -> AuditReport:
    if group.spec is None:
        raise ValueError(f"Група „{group.key}“ няма group.yaml; одитът сравнява с правилата на групата.")
    ctx = Context(group, group.store(store_key))
    products = []
    for p in export.products:
        fields = fields_from_export(p, export, ctx)
        validate_product(fields, ctx)
        products.append(AuditProduct(p.get("Handle", ""), p.get("Title", ""), fields))
    validate_batch([p.fields for p in products])
    return AuditReport(store_key, group.key, export.path.name, products)
