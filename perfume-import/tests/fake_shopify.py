"""A small in-memory Shopify Admin GraphQL server for tests (httpx.MockTransport). It answers only what
pipeline/shopify.py asks and records every request."""

import json

import httpx

CATEGORY_ID = "gid://shopify/TaxonomyCategory/hb-3-2-7-3"


class FakeShopify:
    def __init__(self, products: list[dict] | None = None, throttle: int = 0, reject: str | None = None):
        self.products = {p["id"]: p for p in (products or [])}  # id -> {id, handle, title, sku, ...}
        self.calls: list[dict] = []
        self.uploads: list[bytes] = []
        self.throttle = throttle
        self.reject = reject  # a userErrors message productSet returns
        self.next_id = 1000

    def client(self) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handle))

    def handle(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "staging.example":
            self.uploads.append(request.content)
            return httpx.Response(201)
        if request.headers.get("X-Shopify-Access-Token") != "tok":
            return httpx.Response(401)
        body = json.loads(request.content)
        query, variables = body["query"], body["variables"]
        self.calls.append(body)
        if self.throttle:
            self.throttle -= 1
            return httpx.Response(200, json={"errors": [{"message": "Throttled", "extensions": {"code": "THROTTLED"}}]})
        if "productVariants" in query:
            sku = variables["q"].split('"')[1]
            nodes = [
                {"sku": p["sku"], "product": {"id": p["id"], "handle": p["handle"], "title": p["title"]}}
                for p in self.products.values()
                if p["sku"] == sku
            ]
            return self.ok({"productVariants": {"nodes": nodes}})
        if "productByIdentifier" in query:
            found = next((p for p in self.products.values() if p["handle"] == variables["h"]), None)
            return self.ok({"productByIdentifier": found and {k: found[k] for k in ("id", "handle", "title")}})
        if "product(id:" in query:
            found = self.products.get(variables["id"])
            return self.ok({"product": found and {"id": found["id"]}})
        if "taxonomy" in query:
            node = {"id": CATEGORY_ID, "name": "Perfumes & Colognes", "fullName": "Perfumes & Colognes"}
            return self.ok({"taxonomy": {"categories": {"nodes": [node]}}})
        if "stagedUploadsCreate" in query:
            target = {
                "url": "https://staging.example/upload",
                "resourceUrl": f"https://staging.example/tmp/{len(self.uploads)}",
                "parameters": [{"name": "key", "value": "tmp/1"}],
            }
            return self.ok({"stagedUploadsCreate": {"stagedTargets": [target], "userErrors": []}})
        if "productSet" in query:
            if self.reject:
                error = {"field": ["input", "metafields"], "message": self.reject, "code": "INVALID"}
                return self.ok({"productSet": {"product": None, "userErrors": [error]}})
            data = variables["input"]
            identifier = variables["identifier"]
            if identifier:
                pid = identifier["id"]
            else:
                pid = f"gid://shopify/Product/{self.next_id}"
                self.next_id += 1
            self.products[pid] = {
                "id": pid,
                "handle": data["handle"],
                "title": data["title"],
                "sku": data["variants"][0]["sku"],
                "input": data,
            }
            product = {"id": pid, "handle": data["handle"], "status": data["status"]}
            return self.ok({"productSet": {"product": product, "userErrors": []}})
        raise AssertionError(f"unexpected query: {query[:80]}")

    @staticmethod
    def ok(data: dict) -> httpx.Response:
        return httpx.Response(200, json={"data": data})
