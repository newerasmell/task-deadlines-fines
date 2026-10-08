"""A small in-memory Shopify Admin GraphQL server for tests (httpx.MockTransport). It answers only what
pipeline/shopify.py asks and records every request."""

import json

import httpx

CATEGORY_ID = "gid://shopify/TaxonomyCategory/hb-3-2-7-3"


class FakeShopify:
    def __init__(
        self,
        products: list[dict] | None = None,
        throttle: int = 0,
        reject: str | None = None,
        definitions: dict[tuple[str, str], str] | None = None,
        publications: list[str] | None = None,
        publish_denied: bool = False,
    ):
        self.publications = publications if publications is not None else ["Online Store", "Google & YouTube"]
        self.publish_denied = publish_denied  # the app has no read_publications / write_publications
        self.published: dict[str, list[str]] = {}  # product id -> publication ids
        self.updates: list[dict] = []  # productUpdate inputs (live audit fixes)
        self.variant_updates: list[list[dict]] = []
        self.media_added: list[list[dict]] = []
        self.definitions = definitions or {}  # (namespace, key) -> type, enforced like Shopify does
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
            node = found and {k: found[k] for k in ("id", "handle", "title")}
            if node and "variants(" in query:
                node["variants"] = {"nodes": [{"id": found["id"] + "/v", "sku": found["sku"]}]}
            return self.ok({"productByIdentifier": node})
        if "productUpdate" in query:
            self.updates.append(variables["product"])
            if variables.get("media"):
                self.media_added.append(variables["media"])
            return self.ok({"productUpdate": {"product": {"id": variables["product"]["id"]}, "userErrors": []}})
        if "productVariantsBulkUpdate" in query:
            self.variant_updates.append(variables["variants"])
            return self.ok({"productVariantsBulkUpdate": {"userErrors": []}})
        if "product(id:" in query:
            found = self.products.get(variables["id"])
            return self.ok({"product": found and {"id": found["id"]}})
        if "publications(" in query:
            if self.publish_denied:
                return httpx.Response(200, json={"errors": [{"message": "Access denied for publications field."}]})
            nodes = [{"id": f"gid://shopify/Publication/{i}", "name": n} for i, n in enumerate(self.publications)]
            return self.ok({"publications": {"nodes": nodes}})
        if "publishablePublish" in query:
            self.published[variables["id"]] = [i["publicationId"] for i in variables["input"]]
            return self.ok({"publishablePublish": {"userErrors": []}})
        if "metafieldDefinitions" in query:
            nodes = [{"namespace": n, "key": k, "type": {"name": t}} for (n, k), t in self.definitions.items()]
            return self.ok(
                {"metafieldDefinitions": {"nodes": nodes, "pageInfo": {"hasNextPage": False, "endCursor": None}}}
            )
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
            wrong = [
                f"input.metafields.{i}.type: Type '{m['type']}' must be consistent with the definition's type: "
                f"'{self.definitions[(m['namespace'], m['key'])]}'."
                for i, m in enumerate(data.get("metafields", []))
                if self.definitions.get((m["namespace"], m["key"]), m["type"]) != m["type"]
            ]
            if wrong:
                error = {"field": ["input", "metafields"], "message": "; ".join(wrong), "code": "INVALID"}
                return self.ok({"productSet": {"product": None, "userErrors": [error]}})
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
