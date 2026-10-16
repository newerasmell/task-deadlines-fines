// Shared 6-month rolling window for the "Продажби" tab — orders sync and
// GA4 page-views sync both need to report the SAME window, or units-
// sold/page-views ratios (conversion rate) would silently compare two
// different periods.
export const SALES_PERIOD_MONTHS = 6;

export function salesPeriodStart(now: Date): Date {
  const d = new Date(now);
  d.setMonth(d.getMonth() - SALES_PERIOD_MONTHS);
  return d;
}

// Shorter rolling window for the Campaigns page's "stale stock" filter
// (no/low recent sales) — computed from the SAME orders bulk query as the
// 6-month figures above (see ordersSync.ts), not a separate Shopify
// round trip, since the 6-month query already covers this narrower range.
export const SALES_PERIOD_SHORT_DAYS = 20;

export function salesPeriodShortStart(now: Date): Date {
  return new Date(now.getTime() - SALES_PERIOD_SHORT_DAYS * 24 * 60 * 60 * 1000);
}
