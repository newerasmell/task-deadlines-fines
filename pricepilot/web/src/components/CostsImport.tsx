import { useState } from "react";
import type { ChangeEvent } from "react";
import { api } from "../api/client";

export function CostsImport({ storeId }: { storeId: string }) {
  const [result, setResult] = useState<{ imported: number; errorCount: number; errors: string[] } | null>(null);
  const [importing, setImporting] = useState(false);

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setImporting(true);
    setResult(null);
    try {
      const res = await api<{ imported: number; errorCount: number; errors: string[] }>("/costs/import", {
        method: "POST",
        body: JSON.stringify({ storeId, csv: text }),
      });
      setResult(res);
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  }

  return (
    <div className="card">
      <p className="muted small">
        CSV with two columns: SKU or EAN, then cost (a header row is optional). Used for the margin floor guard —
        products without a cost on file fall back to a percentage of the current price instead.
      </p>
      <input type="file" accept=".csv,text/csv" onChange={handleFile} disabled={importing} />
      {result && (
        <div className="small" style={{ marginTop: 8 }}>
          Imported {result.imported} rows.
          {result.errorCount > 0 && (
            <div className="error-text">
              {result.errorCount} row(s) skipped: {result.errors.join("; ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
