import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4100),
  dashboardPassword: required("DASHBOARD_PASSWORD"),
  sessionSecret: required("SESSION_SECRET"),
  encryptionKey: required("ENCRYPTION_KEY"),
  noCostFloorPct: Number(process.env.NO_COST_FLOOR_PCT ?? 0.7),
  shopifyApiVersion: process.env.SHOPIFY_API_VERSION ?? "2025-01",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5174",
  isProduction: process.env.NODE_ENV === "production",
  // One shared Google OAuth app (Data API for GA4, read-only) used across
  // every store — a store opts in with its own ga4PropertyId, not its own
  // OAuth credentials. All three optional: a store with salesAnalyticsEnabled
  // but no GA4 setup just gets blank page-views/conv-rate columns instead of
  // a startup crash — see services/pageViewsSync.ts.
  googleClientId: process.env.GOOGLE_CLIENT_ID ?? null,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? null,
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN ?? null,
};
