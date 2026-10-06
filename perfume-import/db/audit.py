"""Audit of an existing catalog in the app (SPEC §7, §8.6): findings grouped by rule, the products behind each,
and the fix CSV for Shopify's product import.

Shopify's CSV import (overwrite by handle) leaves columns that are missing from the file alone but blanks a
column that is present and empty. So the fix CSV holds only products with a change and only the columns that
change, and every cell of those columns carries the product's full current value.
"""

import csv
import io
from collections import Counter, defaultdict

from sqlalchemy import select
from sqlalchemy.orm import Session

from db.models import Batch, FieldRow, Product, StoreProduct
from pipeline.config import load_group
from pipeline.fields import SEVERITY

RULES = {
    "format": "Форматиране: интервали, 100ml, кавички",
    "empty_paragraph": "Празен <p></p> в описанието",
    "description_length": "Описание извън дължината на групата",
    "description_missing": "Липсва описание",
    "language_body": "Описание на друг език",
    "language_notes": "Нотки на друг език",
    "tester_sentence": "Тестер без изречението за тестер",
    "tester_marker": "Маркер за тестер в заглавието",
    "title_formula": "Заглавие не по формулата на групата",
    "title_no_ml": "Заглавие без обем",
    "ml_mismatch": "Обемът не съвпада със заглавието",
    "sku_missing": "Липсва SKU",
    "sku_formula": "SKU не следва SK{EAN}",
    "ean_invalid": "Невалиден EAN в SKU",
    "price_missing": "Липсва цена",
    "compare_at_not_above": "Зачеркната цена ≤ цена",
    "compare_at_ratio": "Зачеркната извън разрешеното отношение",
    "image_missing": "Без снимка",
}
FIELD_RULES = {
    "_variant": "{label} извън речника: вариант на позната стойност",
    "_unknown": "{label}: стойност, която я няма в речника",
    "_empty": "Празно поле {label}",
    "_duplicate": "{label} се повтаря",
    "_exists": "{label} вече съществува в магазина",
}
FIELD_LABELS = {"gender": "Пол", "fragrance_family": "Семейство", "sku": "SKU", "handle": "Handle"}
ACTIONS = {
    "fixed": "поправя автоматично",
    "blocked": "спира, решава човек",
    "warning": "предупреждава",
    "suggested": "предлага, решава човек",
}

# Field key -> Shopify CSV column. Metafields are found in the group's import template.
COLUMNS = {
    "title": "Title",
    "vendor": "Vendor",
    "body_html": "Body (HTML)",
    "seo_title": "SEO Title",
    "seo_description": "SEO Description",
    "sku": "Variant SKU",
    "price": "Variant Price",
    "compare_at": "Variant Compare At Price",
}
VARIANT_COLUMNS = {"Variant SKU", "Variant Price", "Variant Compare At Price"}


def rule_label(rule: str) -> str:
    if rule in RULES:
        return RULES[rule]
    for suffix, text in FIELD_RULES.items():
        if rule.endswith(suffix):
            key = rule[: -len(suffix)]
            return text.format(label=FIELD_LABELS.get(key, key))
    return rule


def _engine():
    from db.repo import engine

    return engine()


def _rows(session: Session, batch_id: int):
    batch = session.get(Batch, batch_id)
    if batch is None:
        raise KeyError(f"Няма партида {batch_id}.")
    rows = session.execute(
        select(FieldRow, Product.id, Product.input)
        .join(StoreProduct, StoreProduct.id == FieldRow.store_product_id)
        .join(Product, Product.id == StoreProduct.product_id)
        .where(Product.batch_id == batch_id)
        .order_by(Product.id, FieldRow.id)
    ).all()
    return batch, rows


def summary(batch_id: int) -> dict:
    """Every rule that fired, worst first, with how many fields and products and what the system does."""
    with Session(_engine()) as session:
        batch, rows = _rows(session, batch_id)
        fields = Counter()
        products: dict[str, set[int]] = defaultdict(set)
        status: dict[str, str] = {}
        for row, product_id, _ in rows:
            for issue in row.issues or []:
                rule = issue["rule"]
                if issue["status"] == "ok":
                    continue
                fields[rule] += 1
                products[rule].add(product_id)
                if SEVERITY[issue["status"]] > SEVERITY.get(status.get(rule, "ok"), 0):
                    status[rule] = issue["status"]
        issues = [
            {
                "rule": rule,
                "label": rule_label(rule),
                "status": status[rule],
                "action": ACTIONS[status[rule]],
                "fields": fields[rule],
                "products": len(products[rule]),
            }
            for rule in fields
        ]
        issues.sort(key=lambda i: (-SEVERITY[i["status"]], -i["fields"]))
        product_count = len({product_id for _, product_id, _ in rows})
        changes = _changes(rows)
        return {
            "batch_id": batch.id,
            "name": batch.name,
            "group": batch.group_key,
            "store": batch.store_key,
            "created_at": batch.created_at.isoformat(),
            "products": product_count,
            "issues": issues,
            "fix_products": len(changes),
            "fix_fields": sum(len(c) for c in changes.values()),
        }


def items(batch_id: int, rule: str, offset: int = 0, limit: int = 50) -> dict:
    """The products a rule fired on, with the field, its value, the previous value and the message."""
    with Session(_engine()) as session:
        _, rows = _rows(session, batch_id)
        titles: dict[int, str] = {}
        prices: dict[int, dict] = defaultdict(dict)
        hits = []
        for row, product_id, product_input in rows:
            if row.key == "title":
                titles[product_id] = row.value or product_input.get("title", "")
            if row.key in ("price", "compare_at"):
                prices[product_id][row.key] = row.value
            issue = next((i for i in (row.issues or []) if i["rule"] == rule), None)
            if issue:
                hits.append((product_id, row, issue))
        page = hits[offset : offset + limit]
        return {
            "rule": rule,
            "label": rule_label(rule),
            "total": len(hits),
            "items": [
                {
                    "product_id": product_id,
                    "title": titles.get(product_id, ""),
                    "field_id": row.id,
                    "key": row.key,
                    "value": row.value,
                    "previous": row.previous,
                    "status": row.status,
                    "message": issue["message"],
                    "price": prices[product_id].get("price"),
                    "compare_at": prices[product_id].get("compare_at"),
                    "decided_by": row.decided_by,
                }
                for product_id, row, issue in page
            ],
        }


def _changed(row: FieldRow) -> bool:
    """An automatic fix or a person's decision that changed the value; blocked values never go out."""
    if row.status == "blocked" or row.previous is None:
        return False
    return str(row.value or "") != str(row.previous or "")


def _changes(rows) -> dict[int, dict[str, FieldRow]]:
    out: dict[int, dict[str, FieldRow]] = defaultdict(dict)
    for row, product_id, _ in rows:
        if _changed(row):
            out[product_id][row.key] = row
    return {k: v for k, v in out.items() if v}


def _metafield_column(template: list[str], key: str) -> str | None:
    key = key.removeprefix("custom.")
    return next((c for c in template if c.endswith(f"(product.metafields.custom.{key})")), None)


def fix_csv(batch_id: int) -> tuple[str, bytes]:
    """(filename, CSV) for Shopify: Products → Import, "Overwrite products with matching handles"."""
    with Session(_engine()) as session:
        batch, rows = _rows(session, batch_id)
        group = load_group(batch.group_key)
        by_product: dict[int, dict[str, FieldRow]] = defaultdict(dict)
        for row, product_id, _ in rows:
            by_product[product_id][row.key] = row
        changes = _changes(rows)

    def column(key: str) -> str | None:
        return COLUMNS.get(key) or _metafield_column(group.template_columns, key)

    columns: list[str] = []
    for fields in changes.values():
        for key in fields:
            col = column(key)
            if col and col not in columns:
                columns.append(col)
    variant = any(c in VARIANT_COLUMNS for c in columns)
    header = ["Handle", "Title"] + (["Option1 Name", "Option1 Value"] if variant else [])
    header += [c for c in columns if c not in header]
    fixed = group.spec.fixed if group.spec else {}

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(header)
    for product_id in changes:
        fields = by_product[product_id]
        handle = fields.get("handle")
        values = {
            "Handle": (handle.previous or handle.value) if handle else "",
            "Option1 Name": fixed.get("Option1 Name", "Title"),
            "Option1 Value": fixed.get("Option1 Value", "Default Title"),
        }
        # Every included column gets this product's current value, changed or not: an empty cell would blank it.
        for key, row in fields.items():
            col = column(key)
            if col in header:
                values[col] = "" if row.value is None else row.value
        missing = [c for c in header if c not in values]
        if missing:  # a column this product's export did not have: leave the product out rather than blank it
            continue
        writer.writerow([values[c] for c in header])
    store = batch.store_key or "store"
    return f"fix-{store}-{batch.id}.csv", buf.getvalue().encode("utf-8")
