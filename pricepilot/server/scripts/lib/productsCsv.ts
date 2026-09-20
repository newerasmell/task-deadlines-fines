import { readFileSync, writeFileSync } from "fs";
import { parse } from "csv-parse/sync";
import type { AmbiguousRow, MatchedRow, ProductRow } from "./types";

// Same 10 columns PricePilot's own manual_import "Download template"
// export produces (see EXPORT_HEADER in server/src/routes/sources.ts) —
// reading it back in the same order/shape means the file that comes out
// of that button can be fed straight into loadProducts() below with no
// conversion step.
const INPUT_HEADER = [
  "product_id",
  "sku",
  "vendor",
  "title",
  "size_ml",
  "our_price",
  "search_url",
  "competitor_price",
  "competitor_url",
  "not_found",
];

export function loadProducts(csvPath: string): ProductRow[] {
  const raw = readFileSync(csvPath, "utf-8");
  const records = parse(raw, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  return records
    .map((row) => {
      const normalized: Record<string, string> = {};
      for (const [key, value] of Object.entries(row)) normalized[key.trim().toLowerCase()] = (value ?? "").trim();
      return normalized;
    })
    .filter((row) => row.product_id)
    .map((row) => ({
      productId: row.product_id,
      sku: row.sku ?? "",
      vendor: row.vendor ?? "",
      title: row.title ?? "",
      sizeMl: row.size_ml ?? "",
      ourPrice: row.our_price ?? "",
      searchUrl: row.search_url ?? "",
    }));
}

function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// Writes the exact file PricePilot's POST /sources/:id/import expects to
// receive back — upload it on that manual_import source's page as-is, no
// hand editing needed. Rows where nothing was found still get a row
// (not_found=yes) rather than being dropped, so a re-run's diff against
// the previous output shows what changed.
export function writeResultsCsv(csvPath: string, rows: MatchedRow[]): void {
  const lines = [
    INPUT_HEADER,
    ...rows.map((r) => [
      r.productId,
      r.sku,
      r.vendor,
      r.title,
      r.sizeMl,
      r.ourPrice,
      r.searchUrl,
      r.competitorPrice ?? "",
      r.competitorUrl ?? "",
      r.notFound ? "yes" : "",
    ]),
  ];
  writeFileSync(csvPath, lines.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n", "utf-8");
}

// Writes the format POST /sources/:id/import-ambiguous expects (one row
// per candidate, several rows per product_id) for products this run
// couldn't confidently resolve to a single listing.
export function writeAmbiguousCsv(csvPath: string, rows: AmbiguousRow[]): void {
  const header = ["product_id", "candidate_title", "candidate_url", "candidate_price"];
  const lines = [
    header,
    ...rows.map((r) => [r.productId, r.candidateTitle, r.candidateUrl, r.candidatePrice ?? ""]),
  ];
  writeFileSync(csvPath, lines.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n", "utf-8");
}
