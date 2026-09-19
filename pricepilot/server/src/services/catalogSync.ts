import type { Store } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { ShopifyApiError, shopifyGraphQL } from "./shopifyClient";

// Rough proxy for "catalogs over ~1,000 variants" (the brief's stated
// threshold) without an extra round-trip to count variants directly:
// Shopify catalogs this pilot targets (fragrance) run a handful of
// variants per product, so a product count above this switches to Bulk
// Operations. Tune if a store's variant-per-product ratio differs a lot.
const BULK_THRESHOLD_PRODUCT_COUNT = 250;
const PAGE_SIZE = 50;

interface VariantNode {
  id: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  compareAtPrice: string | null;
  inventoryQuantity: number | null;
}

interface ProductNode {
  id: string;
  title: string;
  vendor: string | null;
  handle: string;
  tags: string[];
  featuredImage: { url: string } | null;
  variants: { edges: { node: VariantNode }[] };
}

async function upsertVariantRow(storeId: string, product: ProductNode, variant: VariantNode) {
  const price = Number(variant.price);
  const compareAtPrice = variant.compareAtPrice != null ? Number(variant.compareAtPrice) : null;
  const tags = (product.tags ?? []).join(",");
  await prisma.product.upsert({
    where: { storeId_shopifyVariantId: { storeId, shopifyVariantId: variant.id } },
    create: {
      storeId,
      shopifyProductId: product.id,
      shopifyVariantId: variant.id,
      title: product.title,
      vendor: product.vendor,
      handle: product.handle,
      sku: variant.sku,
      barcode: variant.barcode,
      price,
      compareAtPrice,
      inventoryQuantity: variant.inventoryQuantity,
      imageUrl: product.featuredImage?.url ?? null,
      tags,
    },
    update: {
      shopifyProductId: product.id,
      title: product.title,
      vendor: product.vendor,
      handle: product.handle,
      sku: variant.sku,
      barcode: variant.barcode,
      price,
      compareAtPrice,
      inventoryQuantity: variant.inventoryQuantity,
      imageUrl: product.featuredImage?.url ?? null,
      tags,
      syncedAt: new Date(),
    },
  });
}

const PRODUCTS_COUNT_QUERY = `query { productsCount { count } }`;

async function getProductsCount(store: Store): Promise<number> {
  const data = await shopifyGraphQL<{ productsCount: { count: number } }>(store, PRODUCTS_COUNT_QUERY);
  return data.productsCount.count;
}

const PRODUCTS_PAGE_QUERY = `
  query ProductsPage($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          vendor
          handle
          tags
          featuredImage { url }
          variants(first: 100) {
            edges { node { id sku barcode price compareAtPrice inventoryQuantity } }
          }
        }
      }
    }
  }
`;

async function syncViaCursor(store: Store): Promise<number> {
  let after: string | null = null;
  let variantCount = 0;

  for (;;) {
    const data: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: { node: ProductNode }[] } } =
      await shopifyGraphQL(store, PRODUCTS_PAGE_QUERY, { first: PAGE_SIZE, after });

    for (const { node: product } of data.products.edges) {
      for (const { node: variant } of product.variants.edges) {
        await upsertVariantRow(store.id, product, variant);
        variantCount++;
      }
    }

    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  }

  return variantCount;
}

const BULK_QUERY = `
  {
    products {
      edges {
        node {
          id
          title
          vendor
          handle
          tags
          featuredImage { url }
          variants {
            edges { node { id sku barcode price compareAtPrice inventoryQuantity } }
          }
        }
      }
    }
  }
`;

const BULK_RUN_MUTATION = `
  mutation RunBulk($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

const CURRENT_BULK_QUERY = `
  query { currentBulkOperation { id status errorCode url objectCount } }
`;

interface BulkOperationStatus {
  id: string;
  status: string;
  errorCode: string | null;
  url: string | null;
  objectCount: string | null;
}

async function pollBulkOperation(store: Store, timeoutMs = 5 * 60 * 1000): Promise<BulkOperationStatus> {
  const start = Date.now();
  for (;;) {
    const data = await shopifyGraphQL<{ currentBulkOperation: BulkOperationStatus | null }>(store, CURRENT_BULK_QUERY);
    const op = data.currentBulkOperation;
    if (!op) throw new ShopifyApiError("No bulk operation is running");
    if (op.status === "COMPLETED") return op;
    if (op.status === "FAILED" || op.status === "CANCELED") {
      throw new ShopifyApiError(`Bulk operation ${op.status.toLowerCase()}: ${op.errorCode ?? "unknown error"}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new ShopifyApiError("Bulk operation timed out");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Bulk Operations results come back as JSONL: one line per node (products
// AND their nested variants, interleaved), each variant line carrying a
// __parentId back-reference to its product's id instead of real nesting.
async function downloadAndParseBulkResult(url: string): Promise<{ product: ProductNode; variant: VariantNode }[]> {
  const res = await fetch(url);
  if (!res.ok) throw new ShopifyApiError(`Failed to download bulk operation result: ${res.status}`);
  const text = await res.text();

  const products = new Map<string, Omit<ProductNode, "variants">>();
  const variantsByParent = new Map<string, VariantNode[]>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const node = JSON.parse(line) as Record<string, unknown> & { id: string; __parentId?: string };

    if (node.__parentId) {
      const variant: VariantNode = {
        id: node.id,
        sku: (node.sku as string | null) ?? null,
        barcode: (node.barcode as string | null) ?? null,
        price: node.price as string,
        compareAtPrice: (node.compareAtPrice as string | null) ?? null,
        inventoryQuantity: (node.inventoryQuantity as number | null) ?? null,
      };
      const list = variantsByParent.get(node.__parentId) ?? [];
      list.push(variant);
      variantsByParent.set(node.__parentId, list);
    } else {
      products.set(node.id, {
        id: node.id,
        title: node.title as string,
        vendor: (node.vendor as string | null) ?? null,
        handle: node.handle as string,
        tags: (node.tags as string[] | null) ?? [],
        featuredImage: (node.featuredImage as { url: string } | null) ?? null,
      });
    }
  }

  const rows: { product: ProductNode; variant: VariantNode }[] = [];
  for (const [productId, product] of products) {
    const variants = variantsByParent.get(productId) ?? [];
    for (const variant of variants) {
      rows.push({ product: { ...product, variants: { edges: [] } }, variant });
    }
  }
  return rows;
}

async function syncViaBulkOperation(store: Store): Promise<number> {
  const run = await shopifyGraphQL<{
    bulkOperationRunQuery: { bulkOperation: { id: string; status: string } | null; userErrors: { field: string[]; message: string }[] };
  }>(store, BULK_RUN_MUTATION, { query: BULK_QUERY });

  if (run.bulkOperationRunQuery.userErrors.length > 0) {
    throw new ShopifyApiError(run.bulkOperationRunQuery.userErrors.map((e) => e.message).join("; "));
  }

  const completed = await pollBulkOperation(store);
  if (!completed.url) return 0; // no products at all

  const rows = await downloadAndParseBulkResult(completed.url);
  for (const { product, variant } of rows) {
    await upsertVariantRow(store.id, product, variant);
  }
  return rows.length;
}

export async function syncCatalog(storeId: string): Promise<{ variantCount: number; method: "cursor" | "bulk" }> {
  const store = await prisma.store.findUniqueOrThrow({ where: { id: storeId } });
  const productCount = await getProductsCount(store);

  if (productCount > BULK_THRESHOLD_PRODUCT_COUNT) {
    const variantCount = await syncViaBulkOperation(store);
    return { variantCount, method: "bulk" };
  }
  const variantCount = await syncViaCursor(store);
  return { variantCount, method: "cursor" };
}
