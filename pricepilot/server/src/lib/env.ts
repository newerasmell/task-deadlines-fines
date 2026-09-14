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
};
