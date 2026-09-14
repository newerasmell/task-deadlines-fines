import { decrypt } from "../lib/crypto";
import { env } from "../lib/env";

export interface ShopifyStoreCreds {
  myshopifyDomain: string;
  adminApiToken: string; // encrypted, as stored in the DB
}

interface GraphQLError {
  message: string;
  extensions?: { code?: string; cost?: unknown };
}

interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
  extensions?: { cost?: { requestedQueryCost: number; actualQueryCost: number; throttleStatus: ThrottleStatus } };
}

export class ShopifyApiError extends Error {
  constructor(message: string, public readonly graphQLErrors?: GraphQLError[]) {
    super(message);
  }
}

const MAX_RETRIES = 5;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottled(errors: GraphQLError[] | undefined): boolean {
  return Boolean(errors?.some((e) => e.extensions?.code === "THROTTLED"));
}

/**
 * Runs one GraphQL request against a store's Admin API, transparently
 * retrying on Shopify's cost-based THROTTLED error using the wait time
 * Shopify's own docs recommend: (requestedCost - currentlyAvailable) /
 * restoreRate seconds, read straight off the response's extensions.cost —
 * falling back to a fixed exponential backoff if that data isn't present.
 */
export async function shopifyGraphQL<T>(
  store: ShopifyStoreCreds,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const token = decrypt(store.adminApiToken);
  const url = `https://${store.myshopifyDomain}/admin/api/${env.shopifyApiVersion}/graphql.json`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok && res.status !== 200) {
      // Shopify returns 200 even for most GraphQL-level errors; a non-200
      // here means something more fundamental (auth, network) went wrong.
      const text = await res.text().catch(() => "");
      throw new ShopifyApiError(`Shopify API request failed: ${res.status} ${text.slice(0, 300)}`);
    }

    const body = (await res.json()) as GraphQLResponse<T>;

    if (body.errors && isThrottled(body.errors)) {
      const throttle = body.extensions?.cost?.throttleStatus;
      const requestedCost = body.extensions?.cost?.requestedQueryCost ?? 50;
      const waitSeconds = throttle
        ? Math.max(0.5, (requestedCost - throttle.currentlyAvailable) / throttle.restoreRate)
        : 0.5 * 2 ** attempt;
      if (attempt === MAX_RETRIES) {
        throw new ShopifyApiError("Shopify API rate limit exceeded after retries", body.errors);
      }
      await sleep(waitSeconds * 1000);
      continue;
    }

    if (body.errors && body.errors.length > 0) {
      throw new ShopifyApiError(body.errors.map((e) => e.message).join("; "), body.errors);
    }

    if (!body.data) {
      throw new ShopifyApiError("Shopify API returned no data");
    }

    return body.data;
  }

  throw new ShopifyApiError("Shopify API request failed after retries");
}

const SHOP_NAME_QUERY = `query { shop { name myshopifyDomain } }`;

export async function testShopifyConnection(
  store: ShopifyStoreCreds
): Promise<{ ok: true; shopName: string } | { ok: false; error: string }> {
  try {
    const data = await shopifyGraphQL<{ shop: { name: string; myshopifyDomain: string } }>(store, SHOP_NAME_QUERY);
    return { ok: true, shopName: data.shop.name };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
