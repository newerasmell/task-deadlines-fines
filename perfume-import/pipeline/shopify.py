"""Upload to Shopify (SPEC §6 last step, §9 phase 5): the finished picture to Files, then the product with its
variant, prices and metafields in one productSet call. Admin GraphQL API, version pinned below.

Idempotent by SKU: a product this app uploaded before (its id is kept in store_products) is updated in place;
a SKU or handle that already exists in the store but was not uploaded from here is reported, never overwritten.
The token comes from the environment variable named in stores.yaml (token_env), never from the repo.
"""

import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from pipeline.config import Group, StoreConfig

API_VERSION = "2026-10"
TIMEOUT = 60
MAX_RETRIES = 5
PERFUME_CATEGORY = "Perfumes & Colognes"  # Shopify Standard Product Taxonomy, looked up by name per store


class ShopifyError(Exception):
    """Something the person can act on; the message is Bulgarian."""


@dataclass
class Uploaded:
    product_id: str
    handle: str
    action: str  # created | updated
    status: str
    notes: list[str] = field(default_factory=list)


# ---- connection ----------------------------------------------------------------------------------------


def client_credential_names(store: StoreConfig) -> tuple[str, str]:
    """SHOPIFY_TOKEN_PARFEMIJA -> SHOPIFY_CLIENT_ID_PARFEMIJA, SHOPIFY_CLIENT_SECRET_PARFEMIJA."""
    suffix = (store.token_env or f"SHOPIFY_TOKEN_{store.key.upper()}").removeprefix("SHOPIFY_TOKEN_")
    return f"SHOPIFY_CLIENT_ID_{suffix}", f"SHOPIFY_CLIENT_SECRET_{suffix}"


_exchanged: dict[str, tuple[str, float]] = {}  # shop -> (token, expires at)


def missing_settings(store: StoreConfig) -> str | None:
    """What is not set up for this store, without calling Shopify (the Upload screen polls it)."""
    if not (store.shop or "").strip() or store.shop == "CHANGE_ME":
        return (
            f"Няма Shopify домейн за {store.label}. Попълни го в Магазини → {store.label} → Shopify адрес "
            "(…myshopify.com) или в config/groups/<група>/stores.yaml."
        )
    id_name, secret_name = client_credential_names(store)
    if not os.environ.get(store.token_env or "") and not (os.environ.get(id_name) and os.environ.get(secret_name)):
        return (
            f"Няма достъп до {store.label}. Добави в средата (в Render: Environment) {id_name} и {secret_name} "
            f"от приложението в Shopify Dev Dashboard, или {store.token_env} с готов токен."
        )
    return None


def credentials(store: StoreConfig, http: httpx.Client | None = None) -> tuple[str, str]:
    """(shop, Admin API token). Either a fixed token (an app made before 2026 in the store admin) in
    token_env, or a Dev Dashboard app's client id and secret, exchanged for a 24-hour token (client credentials
    grant; works when the app and the store belong to the same Shopify organization)."""
    if problem := missing_settings(store):
        raise ShopifyError(problem)
    shop = store.shop.strip()
    token = os.environ.get(store.token_env or "", "")
    if token:
        return shop, token
    id_name, secret_name = client_credential_names(store)
    client_id, secret = os.environ[id_name], os.environ[secret_name]
    cached = _exchanged.get(shop)
    if cached and cached[1] > time.time() + 300:
        return shop, cached[0]
    try:
        response = (http or httpx.Client(timeout=TIMEOUT)).post(
            f"https://{shop}/admin/oauth/access_token",
            data={"grant_type": "client_credentials", "client_id": client_id, "client_secret": secret},
        )
    except httpx.HTTPError as exc:
        raise ShopifyError(f"Няма връзка с {shop}: {type(exc).__name__}.") from exc
    if response.status_code >= 400:
        raise ShopifyError(
            f"{shop} не даде токен (HTTP {response.status_code}). Провери Client ID и Secret и че приложението е "
            "инсталирано в магазина от същата организация."
        )
    body = response.json()
    _exchanged[shop] = (body["access_token"], time.time() + float(body.get("expires_in", 86399)))
    return shop, body["access_token"]


class Shopify:
    def __init__(self, shop: str, token: str, http: httpx.Client | None = None, sleep=time.sleep):
        self.shop = shop
        self.url = f"https://{shop}/admin/api/{API_VERSION}/graphql.json"
        self.http = http or httpx.Client(timeout=TIMEOUT)
        self.headers = {"X-Shopify-Access-Token": token, "Content-Type": "application/json"}
        self.sleep = sleep
        self._category: str | None | bool = False  # False = not looked up yet
        self._metafield_types: dict[tuple[str, str], str] | None = None

    def graphql(self, query: str, variables: dict | None = None) -> dict:
        """One call; waits and retries while Shopify throttles (HTTP 429 or a THROTTLED error)."""
        for attempt in range(MAX_RETRIES + 1):
            try:
                response = self.http.post(
                    self.url, json={"query": query, "variables": variables or {}}, headers=self.headers
                )
            except httpx.HTTPError as exc:
                raise ShopifyError(f"Няма връзка с {self.shop}: {type(exc).__name__}.") from exc
            if response.status_code == 429 and attempt < MAX_RETRIES:
                self.sleep(float(response.headers.get("Retry-After", 2)))
                continue
            if response.status_code in (401, 403):
                raise ShopifyError(
                    f"{self.shop} отказа достъпа (HTTP {response.status_code}). Провери токена и правата му "
                    "(write_products, write_files)."
                )
            if response.status_code >= 400:
                raise ShopifyError(f"{self.shop} отговори с HTTP {response.status_code}.")
            body = response.json()
            errors = body.get("errors") or []
            if any((e.get("extensions") or {}).get("code") == "THROTTLED" for e in errors) and attempt < MAX_RETRIES:
                self.sleep(2**attempt)
                continue
            if errors:
                raise ShopifyError("Shopify: " + "; ".join(e.get("message", "грешка") for e in errors))
            return body["data"]
        raise ShopifyError(f"{self.shop} ограничава заявките твърде дълго. Опитай отново след минута.")

    # ---- lookups ----

    def find_by_sku(self, sku: str) -> dict | None:
        data = self.graphql(
            """query($q: String!) { productVariants(first: 5, query: $q) {
                 nodes { sku product { id handle title } } } }""",
            {"q": f'sku:"{sku}"'},
        )
        nodes = [n for n in data["productVariants"]["nodes"] if n["sku"] == sku]
        return nodes[0]["product"] if nodes else None

    def find_by_handle(self, handle: str) -> dict | None:
        data = self.graphql(
            "query($h: String!) { productByIdentifier(identifier: {handle: $h}) { id handle title } }",
            {"h": handle},
        )
        return data["productByIdentifier"]

    def exists(self, product_id: str) -> bool:
        data = self.graphql("query($id: ID!) { product(id: $id) { id } }", {"id": product_id})
        return data["product"] is not None

    def category(self) -> str | None:
        """The taxonomy id for perfumes, looked up once per store connection (ids are not guessed)."""
        if self._category is False:
            data = self.graphql(
                """query($s: String!) { taxonomy { categories(first: 10, search: $s) {
                     nodes { id name fullName } } } }""",
                {"s": PERFUME_CATEGORY},
            )
            nodes = data["taxonomy"]["categories"]["nodes"]
            exact = [n for n in nodes if n["name"] == PERFUME_CATEGORY]
            self._category = (exact or nodes or [{"id": None}])[0]["id"]
        return self._category or None

    def metafield_types(self) -> dict[tuple[str, str], str]:
        """(namespace, key) -> type of the store's product metafield definitions, looked up once. A metafield
        must be sent with its definition's type (a store may define notes as multi-line text or a list)."""
        if self._metafield_types is None:
            types, after = {}, None
            for _ in range(10):
                data = self.graphql(
                    """query($after: String) { metafieldDefinitions(ownerType: PRODUCT, first: 250, after: $after) {
                         nodes { namespace key type { name } } pageInfo { hasNextPage endCursor } } }""",
                    {"after": after},
                )
                page = data["metafieldDefinitions"]
                types.update({(n["namespace"], n["key"]): n["type"]["name"] for n in page["nodes"]})
                if not page["pageInfo"]["hasNextPage"]:
                    break
                after = page["pageInfo"]["endCursor"]
            self._metafield_types = types
        return self._metafield_types

    # ---- writes ----

    def stage_image(self, data: bytes, filename: str, mime: str) -> str:
        """Upload the picture to Shopify's staging bucket; returns the resourceUrl for productSet files."""
        result = self.graphql(
            """mutation($input: [StagedUploadInput!]!) { stagedUploadsCreate(input: $input) {
                 stagedTargets { url resourceUrl parameters { name value } }
                 userErrors { field message } } }""",
            {
                "input": [
                    {
                        "filename": filename,
                        "mimeType": mime,
                        "httpMethod": "POST",
                        "resource": "IMAGE",
                        "fileSize": str(len(data)),
                    }
                ]
            },
        )["stagedUploadsCreate"]
        if result["userErrors"]:
            raise ShopifyError("Снимката не е приета: " + "; ".join(e["message"] for e in result["userErrors"]))
        target = result["stagedTargets"][0]
        form = {p["name"]: p["value"] for p in target["parameters"]}
        try:
            response = self.http.post(target["url"], data=form, files={"file": (filename, data, mime)})
        except httpx.HTTPError as exc:
            raise ShopifyError(f"Снимката не се качи: {type(exc).__name__}.") from exc
        if response.status_code >= 300:
            raise ShopifyError(f"Снимката не се качи (HTTP {response.status_code}).")
        return target["resourceUrl"]

    def product_set(self, product: dict, product_id: str | None = None) -> dict:
        data = self.graphql(
            """mutation($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
                 productSet(input: $input, identifier: $identifier, synchronous: true) {
                   product { id handle status }
                   userErrors { field message code } } }""",
            {"input": product, "identifier": {"id": product_id} if product_id else None},
        )["productSet"]
        if result_errors := data["userErrors"]:
            raise ShopifyError(
                "Shopify не прие продукта: "
                + "; ".join(f"{'.'.join(map(str, e.get('field') or []))}: {e['message']}" for e in result_errors)
            )
        return data["product"]


# ---- payload ---------------------------------------------------------------------------------------------


CUSTOM_METAFIELDS = {
    "gender": "gender",
    "fragrance_family": "fragrance_family",
    "top_note": "top_note",
    "middle_note": "middle_note",
    "base_note": "base_note",
    "ingredients": "ingredients",
    "custom.product_milliliters": "product_milliliters",
    "custom.product_type": "product_type",
}
GOOGLE_METAFIELDS = {
    "google.gender": "gender",
    "google.product_category": "google_product_category",
    "google.condition": "condition",
}
GOOGLE_NAMESPACE = "mm-google-shopping"  # where the stores' "Google Shopping / …" columns live


def _value(fields: dict, key: str) -> Any:
    f = fields.get(key)
    return None if f is None else f.value


def _text(value) -> str:
    return "" if value is None else str(value).strip()


def _bool(value, default: bool) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("true", "1", "yes", "да")


def metafield(namespace: str, key: str, value: str, types: dict[tuple[str, str], str]) -> dict | None:
    """A metafield in the type the store defined for it; plain one-line text where it has no definition.
    None when the value cannot be written in that type (it is left out rather than rejected)."""
    kind = types.get((namespace, key), "single_line_text_field")
    if kind.startswith("list."):
        items = [i.strip() for i in value.split(",") if i.strip()]
        if kind in ("list.number_integer", "list.number_decimal"):
            return None
        out = json.dumps(items, ensure_ascii=False)
    elif kind in ("number_integer", "number_decimal"):
        number = re.search(r"\d+(?:[.,]\d+)?", value)
        if not number:
            return None
        n = number.group().replace(",", ".")
        out = str(int(float(n))) if kind == "number_integer" else n
    elif kind == "boolean":
        out = "true" if _bool(value, False) else "false"
    elif kind in ("single_line_text_field", "multi_line_text_field", "rich_text_field") or kind.endswith("_text_field"):
        out = value
    else:
        return None  # a reference, date, dimension…: nothing here can fill it safely
    if kind == "rich_text_field":
        out = json.dumps(
            {"type": "root", "children": [{"type": "paragraph", "children": [{"type": "text", "value": value}]}]}
        )
    return {"namespace": namespace, "key": key, "type": kind, "value": out}


def product_input(
    fields: dict,
    status: str,
    category: str | None,
    image: str | None,
    metafield_types: dict[tuple[str, str], str] | None = None,
) -> dict:
    """ProductSetInput from one store product's fields (field records with .value), nothing invented.

    image: a staged resourceUrl or a public URL; None leaves the product without media.
    metafield_types: the store's definitions (Shopify.metafield_types); missing ones go as one-line text."""
    types = metafield_types or {}
    sku = _text(_value(fields, "sku"))
    ean = _text(_value(fields, "ean"))
    option_name = _text(_value(fields, "fixed.Option1 Name")) or "Title"
    option_value = _text(_value(fields, "fixed.Option1 Value")) or "Default Title"
    grams = _value(fields, "fixed.Variant Grams")
    inventory_item: dict[str, Any] = {
        "tracked": _text(_value(fields, "fixed.Variant Inventory Tracker")).lower() == "shopify",
        "requiresShipping": _bool(_value(fields, "fixed.Variant Requires Shipping"), True),
    }
    if grams not in (None, ""):
        inventory_item["measurement"] = {"weight": {"value": float(grams), "unit": "GRAMS"}}
    compare = _text(_value(fields, "compare_at"))
    variant: dict[str, Any] = {
        "optionValues": [{"optionName": option_name, "name": option_value}],
        "sku": sku,
        "compareAtPrice": compare or None,
        "taxable": _bool(_value(fields, "fixed.Variant Taxable"), False),
        "inventoryPolicy": "CONTINUE"
        if _text(_value(fields, "fixed.Variant Inventory Policy")).lower() == "continue"
        else "DENY",
        "inventoryItem": inventory_item,
    }
    if price := _text(_value(fields, "price")):
        variant["price"] = price  # no price: Shopify keeps 0.00 until it is set there (draft only, decisions #16)
    if ean:
        variant["barcodes"] = [{"value": ean}]  # the EAN also as the variant barcode (GTIN for Google)

    metafields = []
    for namespace, mapping in (("custom", CUSTOM_METAFIELDS), (GOOGLE_NAMESPACE, GOOGLE_METAFIELDS)):
        for key, mf_key in mapping.items():
            if (value := _text(_value(fields, key))) and (mf := metafield(namespace, mf_key, value, types)):
                metafields.append(mf)

    product: dict[str, Any] = {
        "title": _text(_value(fields, "title")),
        "handle": _text(_value(fields, "handle")),
        "descriptionHtml": _text(_value(fields, "body_html")),
        "vendor": _text(_value(fields, "vendor")),
        "productType": _text(_value(fields, "custom.product_type")),
        "status": status.upper(),
        "giftCard": _bool(_value(fields, "fixed.Gift Card"), False),
        "seo": {
            "title": _text(_value(fields, "seo_title")) or _text(_value(fields, "title")),
            "description": _text(_value(fields, "seo_description")),
        },
        "productOptions": [{"name": option_name, "values": [{"name": option_value}]}],
        "variants": [variant],
        "metafields": metafields,
    }
    if category:
        product["category"] = category
    if image:
        product["files"] = [{"originalSource": image, "alt": product["title"], "contentType": "IMAGE"}]
    return product


def upload_product(
    shop: Shopify,
    fields: dict,
    status: str,
    known_id: str | None,
    image: tuple[bytes, str, str] | str | None,
) -> Uploaded:
    """Create or update one product. image: (data, filename, mime) to stage, or a public URL."""
    sku = _text(_value(fields, "sku"))
    handle = _text(_value(fields, "handle"))
    if not sku:
        raise ShopifyError("Продуктът няма SKU; не се качва.")
    if status.lower() == "active" and not _text(_value(fields, "price")):
        raise ShopifyError("Няма цена: продукт без цена се качва само като чернова. Качи го като чернова.")
    notes = []
    target = known_id if known_id and shop.exists(known_id) else None
    if known_id and not target:
        notes.append("Продуктът е изтрит в Shopify след предишното качване; създаден е наново.")
    if not target:
        existing = shop.find_by_sku(sku)
        if existing:
            raise ShopifyError(
                f"SKU {sku} вече съществува в магазина ({existing['title']}). Провери дублирания продукт."
            )
        by_handle = shop.find_by_handle(handle) if handle else None
        if by_handle:
            raise ShopifyError(f"Handle „{handle}“ е зает от „{by_handle['title']}“. Промени заглавието или handle.")
    source = shop.stage_image(*image) if isinstance(image, tuple) else image
    category = shop.category()
    if not category:
        notes.append("Категорията Perfumes & Colognes не е намерена в таксономията; продуктът е без категория.")
    result = shop.product_set(product_input(fields, status, category, source, shop.metafield_types()), target)
    return Uploaded(
        product_id=result["id"],
        handle=result["handle"],
        action="updated" if target else "created",
        status=result["status"],
        notes=notes,
    )


def store_client(group: Group, store_key: str, http: httpx.Client | None = None) -> Shopify:
    shop, token = credentials(group.store(store_key), http)
    return Shopify(shop, token, http=http)
