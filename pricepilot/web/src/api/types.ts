export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  isUltimateAdmin: boolean;
}

export interface TeamUser {
  id: string;
  name: string;
  email: string;
  active: boolean;
  isUltimateAdmin: boolean;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  actor: { id: string; name: string; email: string } | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  createdAt: string;
}

export type PricingStrategy = "undercut_min" | "match_min" | "undercut_avg";
export type PricingProfile = "competitor" | "cod_formula";
export type SourceType = "shopify_json" | "scrape" | "manual_import" | "jeftinije_hr" | "notino_hr";
export type RowFlag = "above-market" | "competitive" | "below-market" | "below-floor" | "no-data";

export interface Group {
  id: string;
  name: string;
  createdAt: string;
  storeCount?: number;
}

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
  pricingProfile: PricingProfile;
  groupId: string | null;
  hasClientSecret: boolean;
  salesAnalyticsEnabled: boolean;
  ga4PropertyId: string | null;
  markdownEnabled: boolean;
  markdownCollectionId: string | null;
  markdownAfterDays: number;
  markdownCeilingPct: number;
  createdAt: string;
  updatedAt: string;
}

export type CodFormulaMode = "cost" | "target" | "breakeven";

export interface CodScenarioInput {
  key: string;
  label: string;
  A: number;
  d: number; // 0-100 %
  S: number;
}

export interface CodBracketInput {
  upper: number | null;
  rate: number; // 0-100 %
}

export interface CodFormulaConfig {
  id: string;
  storeId: string;
  mode: CodFormulaMode;
  cogsPct: number;
  fRate: number;
  mRate: number;
  nItems: number;
  rMult: number;
  lLoss: number;
  fCost: number;
  roundStep: number;
  discountPct: number;
  discountTag: string;
  pricingScenario: string;
  pricingN: number;
  scenariosJson: string;
  bracketsJson: string;
}

export interface CodFormulaInfo {
  config: CodFormulaConfig;
  avgCost: number;
  k: number | null;
  reason: string | null;
  scenario: string;
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
  isManual: boolean;
}

export interface PricingRow {
  productId: string;
  shopifyProductId: string;
  shopifyVariantId: string;
  title: string;
  // The variant's own Shopify title (e.g. "42") — null for a single-variant
  // product (Shopify's "Default Title" placeholder is normalized away
  // server-side), used only to label a row inside its size group.
  variantTitle: string | null;
  // Shopify's own configured display order for this variant within its
  // product — used to sort a group's rows the way Shopify's admin already
  // orders them (S/M/L/XL isn't sortable any other way).
  variantPosition: number | null;
  vendor: string | null;
  handle: string | null;
  sku: string | null;
  barcode: string | null;
  imageUrl: string | null;
  tags: string[];
  categoryIds: string[];
  discountTagged?: boolean;
  cost: number | null;
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
  recommendedComparePrice: number | null;
  recommendedComparePriceReason?: string | null; // why it's blank, e.g. "brand X has no coefficient set"
  floor: number;
  flag: RowFlag;
  markdownEligible?: boolean; // COD stores only — past the new-arrival wait window and still priced above the ceiling
  daysSinceActive?: number | null;
  saleDiscountApplied?: boolean; // COD stores only — tagged with the SALE tag and an extra cut was applied on top of `suggested`
  saleDiscountPct?: number | null; // 30-35, placed by the brand's coefficient — null unless saleDiscountApplied
  salePreDiscountPrice?: number | null; // `suggested` before the SALE cut (the normal formula/markdown price) — null unless saleDiscountApplied
  activatedAt: string | null; // when this variant was first synced ACTIVE in Shopify — null if never observed active
}

export interface PricingTableResponse {
  sources: { id: string; label: string; active: boolean; degraded: boolean; lastRefreshedAt: string | null }[];
  categories: { id: string; title: string }[];
  rows: PricingRow[];
  formula: CodFormulaInfo | null;
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
  source: "single" | "bulk" | "revert";
  revertedAt: string | null;
  createdAt: string;
}

export interface RevertResultItem {
  logId: string;
  status: "SUCCESS" | "ERROR";
  errorMessage?: string;
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

export interface SalesProductRow {
  productId: string;
  title: string;
  vendor: string | null;
  sku: string | null;
  imageUrl: string | null;
  inventoryQuantity: number | null;
  unitsSold6m: number;
  avgSalePrice6m: number | null;
  pageViews6m: number | null;
  convRate6m: number | null; // percent, e.g. 3.2 = 3.2%
  categoryIds: string[];
}

export interface SalesCategoryRow {
  categoryId: string;
  title: string;
  productCount: number;
  unitsSold6m: number;
  avgSalePrice6m: number | null;
  pageViews6m: number | null;
  convRate6m: number | null;
  cost: number | null; // manually-set average acquisition cost, COD stores only
  currency: string;
  baseMinPrice: number | null; // manually-set envelope for the suggested base/compare-at price, COD stores only
  baseMaxPrice: number | null;
}

export interface BrandRow {
  vendor: string;
  productCount: number;
  coefficient: number | null; // 1-10, null until set — ranks this brand's price tier against others in the same category
}

export interface SalesResponse {
  salesAnalyticsEnabled: boolean;
  pricingProfile: PricingProfile;
  currency: string;
  products: SalesProductRow[];
  categories: SalesCategoryRow[];
}
