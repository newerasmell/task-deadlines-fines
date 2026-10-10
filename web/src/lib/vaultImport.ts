// Parses a CSV/XLSX file ENTIRELY in the browser — the raw file (plaintext
// passwords and all) is never sent anywhere, only read with the File API
// and parsed in memory, exactly like vaultCrypto.ts never sends a master
// password or derived key off the device. Covers the two shapes people
// actually bring in: a CSV export (1Password, Chrome/Edge, Firefox all
// export logins as CSV) and an ad-hoc .xlsx tracking sheet.
import { readSheet } from "read-excel-file/browser";

export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

export type VaultField = "title" | "username" | "password" | "url" | "notes";

export const VAULT_FIELDS: VaultField[] = ["title", "username", "password", "url", "notes"];

// Column header aliases this recognizes out of the box — covers 1Password's
// own CSV export ("Title", "Url", "Username", "Password", "Notes"),
// Chrome/Edge's export ("name", "url", "username", "password"), Firefox's
// export ("url", "username", "password" — no title column, handled by the
// url-based fallback in buildEntryFromRow below), and common
// Bulgarian/English spreadsheet headers people make by hand.
const FIELD_ALIASES: Record<VaultField, string[]> = {
  title: ["title", "name", "site", "account", "заглавие", "име", "сайт", "акаунт"],
  username: ["username", "user", "login", "email", "e-mail", "потребител", "потребителско име", "имейл"],
  password: ["password", "pass", "pwd", "парола"],
  url: ["url", "website", "web site", "link", "formactionorigin", "httprealm", "уебсайт", "линк", "адрес"],
  notes: ["notes", "note", "comment", "comments", "extra", "бележка", "бележки", "коментар"],
};

export async function parseImportFile(file: File): Promise<ParsedTable> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    return toTable(parseCsv(await file.text()));
  }
  const sheetRows = await readSheet(file);
  return toTable(sheetRows.map((row) => row.map(cellToString)));
}

function cellToString(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v);
}

function toTable(rows: string[][]): ParsedTable {
  const [headerRow, ...dataRows] = rows;
  const headers = (headerRow ?? []).map((h) => h.trim());
  return { headers, rows: dataRows.filter((r) => r.some((c) => c.trim() !== "")) };
}

// A small RFC4180-ish CSV parser — handles quoted fields, escaped quotes
// (""), commas/newlines inside quotes, and both \r\n and \n line endings.
// Written by hand rather than pulling in another dependency: this page
// handles plaintext passwords, so every extra package here is attack
// surface, and CSV parsing is simple enough to keep fully auditable.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function guessColumnMapping(headers: string[]): Partial<Record<VaultField, number>> {
  const mapping: Partial<Record<VaultField, number>> = {};
  const used = new Set<number>();
  const normalized = headers.map((h) => h.toLowerCase().trim());

  for (const field of VAULT_FIELDS) {
    const aliases = FIELD_ALIASES[field];
    let bestIdx = normalized.findIndex((h, i) => !used.has(i) && aliases.includes(h));
    if (bestIdx === -1) {
      bestIdx = normalized.findIndex((h, i) => !used.has(i) && aliases.some((a) => h.includes(a)));
    }
    if (bestIdx !== -1) {
      mapping[field] = bestIdx;
      used.add(bestIdx);
    }
  }
  return mapping;
}
