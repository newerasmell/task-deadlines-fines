export type PricingStrategy = "undercut_min" | "match_min" | "undercut_avg";
export type SourceType = "shopify_json" | "scrape" | "manual_import" | "jeftinije_hr" | "notino_hr";
export type RowFlag = "above-market" | "competitive" | "below-market" | "below-floor" | "no-data";

export interface Store {
  id: string;
  name: string;
  myshopifyDomain: string;
  shopifyClientId: string;
  marketCode: string;
  currency: string;
  pricingStrategy: PricingStrategy;
  undercutPct: number;
  priceEnding: string | null;
  minMarginPct: number;
  hasClientSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Source {
  id: string;
  storeId: string;
  label: string;
  type: SourceType;
  baseUrl: string;
  searchUrlTemplate: string | null;
  active: boolean;
  autoRefresh: boolean;
  lastRefreshedAt: string | null;
  lastTriggeredBy: string | null;
  lastMatchedCount: number | null;
  consecutiveFailures: number;
  degraded: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AmbiguousMatchCandidate {
  title: string;
  price: number | null;
  url: string;
  // True when the listing's title had no extractable size — its shown
  // price can belong to a different variant than the one being matched
  // (confirmed live on notino.hr), so it isn't safe to trust without
  // checking the actual product page first.
  sizeUnconfirmed?: boolean;
}

export interface AmbiguousMatch {
  id: string;
  productId: string;
  productTitle: string;
  productVendor: string | null;
  productSku: string | null;
  ourPrice: number;
  candidates: AmbiguousMatchCandidate[];
  createdAt: string;
}

export interface SourcePriceCell {
  price: number;
  currency: string;
  url: string | null;
  fetchedAt: string;
  stale: boolean;
}

export interface PricingRow {
  productId: string;
  shopifyVariantId: string;
  title: string;
  vendor: string | null;
  handle: string | null;
  sku: string | null;
  barcode: string | null;
  imageUrl: string | null;
  ourPrice: number;
  compareAtPrice: number | null;
  inventoryQuantity: number | null;
  priority: boolean;
  sourcePrices: Record<string, SourcePriceCell>;
  matchedSourceCount: number;
  minComp: number | null;
  avgComp: number | null;
  deltaPct: number | null;
  suggested: number | null;
  floor: number;
  flag: RowFlag;
}

export interface PricingTableResponse {
  sources: { id: string; label: string; active: boolean; degraded: boolean; lastRefreshedAt: string | null }[];
  rows: PricingRow[];
}

export interface PublishResultItem {
  productId: string;
  variantId: string;
  status: "SUCCESS" | "ERROR";
  errorMessage?: string;
}

export interface PublishLogEntry {
  id: string;
  storeId: string;
  variantId: string;
  productTitle: string | null;
  oldPrice: number;
  newPrice: number;
  oldCompareAt: number | null;
  newCompareAt: number | null;
  status: "SUCCESS" | "ERROR";
  errorMessage: string | null;
  source: "single" | "bulk";
  createdAt: string;
}

export interface UnmatchedRow {
  id: string;
  sourceId: string;
  sourceLabel: string;
  matchKey: string;
  competitorTitle: string | null;
  competitorSku: string | null;
  competitorBarcode: string | null;
  price: number;
  currency: string;
  url: string | null;
  fetchedAt: string;
}

export interface ScrapeAttempt {
  id: string;
  productId: string;
  productTitle: string;
  productVendor: string | null;
  productSku: string | null;
  found: boolean;
  price: number | null;
  error: string | null;
  url: string;
  attemptedAt: string;
}

export interface Cost {
  id: string;
  storeId: string;
  skuOrEan: string;
  cost: number;
}
