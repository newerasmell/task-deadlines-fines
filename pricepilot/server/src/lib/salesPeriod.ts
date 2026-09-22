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
