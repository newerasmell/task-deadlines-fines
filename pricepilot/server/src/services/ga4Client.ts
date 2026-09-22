import { env } from "../lib/env";

export class Ga4ApiError extends Error {}

// One shared Google OAuth app (env.google*) exchanged for a fresh access
// token on every call — GA4 Data API tokens are short-lived and this runs
// at most once per store per sync cycle, so there's no real cost to
// skipping the caching layer shopifyClient.ts needs for its much higher
// request volume.
async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.googleClientId!,
      client_secret: env.googleClientSecret!,
      refresh_token: env.googleRefreshToken!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Ga4ApiError(`GA4 token refresh failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

interface RunReportResponse {
  rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
}

// Maps Shopify product handle -> page views in [periodStart, periodEnd],
// summed across every URL variant GA4 recorded for that product (locale
// prefixes, ?variant= query strings, etc. all still contain the same
// "/products/<handle>" segment). pagePath is GA4's own field name; nothing
// here is Shopify-specific beyond that URL shape, which is Shopify's fixed
// storefront routing.
export async function fetchProductPageViews(
  propertyId: string,
  periodStart: Date,
  periodEnd: Date
): Promise<Map<string, number>> {
  const token = await getAccessToken();
  const isoDate = (d: Date) => d.toISOString().slice(0, 10);

  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate: isoDate(periodStart), endDate: isoDate(periodEnd) }],
      dimensions: [{ name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }],
      dimensionFilter: {
        filter: { fieldName: "pagePath", stringFilter: { matchType: "CONTAINS", value: "/products/" } },
      },
      limit: 100000,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Ga4ApiError(`GA4 report request failed: ${res.status} ${text.slice(0, 300)}`);
  }

  const body = (await res.json()) as RunReportResponse;
  const byHandle = new Map<string, number>();
  for (const row of body.rows ?? []) {
    const path = row.dimensionValues[0]?.value ?? "";
    const match = path.match(/\/products\/([^/?]+)/);
    if (!match) continue;
    const handle = match[1];
    const views = Number(row.metricValues[0]?.value ?? 0) || 0;
    byHandle.set(handle, (byHandle.get(handle) ?? 0) + views);
  }
  return byHandle;
}
