"""Shopify upload against an in-memory Admin API: payload, idempotency by SKU, images, errors."""

import pytest

from pipeline.batch import run_batch
from pipeline.input import read_input
from pipeline.settings import ROOT
from pipeline.shopify import Shopify, ShopifyError, credentials, product_input, upload_product
from tests.fake_ai import FakeClient
from tests.fake_shopify import CATEGORY_ID, FakeShopify
from tests.test_batch import GROUP, STORES, responder


@pytest.fixture(scope="module")
def fields():
    import pipeline.generate

    original = pipeline.generate.load_glossary
    pipeline.generate.load_glossary = lambda lang: {}
    try:
        rows = read_input(ROOT / "input" / "sample-5.csv", GROUP, STORES)[:1]
        result = run_batch(FakeClient(responder=responder), rows, GROUP, STORES, "shopify test")
    finally:
        pipeline.generate.load_glossary = original
    return result.products[0].stores["premierparfums"]


def shop(fake: FakeShopify) -> Shopify:
    return Shopify("test.myshopify.com", "tok", http=fake.client(), sleep=lambda s: None)


def test_payload_comes_from_the_fields(fields):
    p = product_input(fields, "draft", CATEGORY_ID, "https://staging.example/tmp/1")
    assert p["title"] == fields["title"].value and p["handle"] == fields["handle"].value
    assert p["status"] == "DRAFT" and p["category"] == CATEGORY_ID
    assert p["descriptionHtml"].startswith("<p>Το Paco")
    assert p["productType"] == "EDP"
    variant = p["variants"][0]
    assert variant["sku"] == fields["sku"].value and variant["barcodes"] == [{"value": fields["ean"].value}]
    assert variant["price"] == "58.00" and variant["compareAtPrice"] is None
    assert variant["inventoryPolicy"] == "DENY" and variant["taxable"] is False
    assert variant["inventoryItem"] == {
        "tracked": True,
        "requiresShipping": True,
        "measurement": {"weight": {"value": 300.0, "unit": "GRAMS"}},
    }
    assert p["productOptions"] == [{"name": "Title", "values": [{"name": "Default Title"}]}]
    meta = {(m["namespace"], m["key"]): m["value"] for m in p["metafields"]}
    assert meta[("custom", "gender")] == "Women's Perfume"
    assert meta[("custom", "top_note")] == "sicilian lemon-el"
    assert meta[("custom", "product_milliliters")] == "110 ml"
    assert meta[("mm-google-shopping", "gender")] == "Women"
    assert meta[("mm-google-shopping", "google_product_category")] == "479"
    assert ("custom", "ingredients") not in meta  # empty values are not sent
    assert p["files"][0]["originalSource"] == "https://staging.example/tmp/1"


def test_create_then_update_by_the_kept_id(fields):
    fake = FakeShopify()
    first = upload_product(shop(fake), fields, "draft", None, (b"png-bytes", "x.png", "image/png"))
    assert first.action == "created" and first.status == "DRAFT"
    assert fake.uploads and b"png-bytes" in fake.uploads[0]
    second = upload_product(shop(fake), fields, "active", first.product_id, None)
    assert second.action == "updated" and second.product_id == first.product_id
    assert len(fake.products) == 1  # never a duplicate


def test_existing_sku_or_handle_is_reported_not_overwritten(fields):
    other = {"id": "gid://shopify/Product/1", "handle": "other", "title": "Старият продукт", "sku": fields["sku"].value}
    with pytest.raises(ShopifyError, match="вече съществува"):
        upload_product(shop(FakeShopify([other])), fields, "draft", None, None)
    taken = {**other, "sku": "SK0", "handle": fields["handle"].value}
    with pytest.raises(ShopifyError, match="зает"):
        upload_product(shop(FakeShopify([taken])), fields, "draft", None, None)


def test_deleted_in_shopify_is_created_again(fields):
    fake = FakeShopify()
    result = upload_product(shop(fake), fields, "draft", "gid://shopify/Product/404", None)
    assert result.action == "created" and "изтрит" in result.notes[0]


def test_throttling_is_retried_and_user_errors_are_shown(fields):
    fake = FakeShopify(throttle=2)
    assert upload_product(shop(fake), fields, "draft", None, None).action == "created"
    with pytest.raises(ShopifyError, match="Shopify не прие продукта: input.metafields: bad type"):
        upload_product(shop(FakeShopify(reject="bad type")), fields, "draft", None, None)


def test_missing_shop_or_token_says_what_to_do(monkeypatch):
    store = GROUP.store("premierparfums")
    with pytest.raises(ShopifyError, match="stores.yaml"):
        credentials(store)  # shop is CHANGE_ME in the seed
    monkeypatch.setattr(store, "shop", "premier.myshopify.com")
    monkeypatch.delenv(store.token_env, raising=False)
    with pytest.raises(ShopifyError, match="SHOPIFY_CLIENT_ID_PREMIERPARFUMS"):
        credentials(store)
    monkeypatch.setenv(store.token_env, "tok")
    assert credentials(store) == ("premier.myshopify.com", "tok")
    with pytest.raises(ShopifyError, match="отказа достъпа"):
        Shopify("x.myshopify.com", "wrong", http=FakeShopify().client()).graphql("{ shop { id } }")


def test_dev_dashboard_app_exchanges_client_credentials(monkeypatch):
    import httpx

    from pipeline import shopify

    store = GROUP.store("parfemija")
    monkeypatch.setattr(store, "shop", "parfemija.myshopify.com")
    monkeypatch.delenv(store.token_env, raising=False)
    monkeypatch.setenv("SHOPIFY_CLIENT_ID_PARFEMIJA", "id")
    monkeypatch.setenv("SHOPIFY_CLIENT_SECRET_PARFEMIJA", "secret")
    monkeypatch.setattr(shopify, "_exchanged", {})
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.content.decode())
        return httpx.Response(200, json={"access_token": "shpat_x", "scope": "write_products", "expires_in": 86399})

    http = httpx.Client(transport=httpx.MockTransport(handler))
    assert credentials(store, http) == ("parfemija.myshopify.com", "shpat_x")
    assert credentials(store, http) == ("parfemija.myshopify.com", "shpat_x")  # cached for 24 h
    assert len(seen) == 1 and "grant_type=client_credentials" in seen[0] and "client_id=id" in seen[0]
