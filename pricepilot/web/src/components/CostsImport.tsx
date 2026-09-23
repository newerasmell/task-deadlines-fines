import { useState } from "react";
import type { ChangeEvent } from "react";
import { api } from "../api/client";
import { useT } from "../i18n/I18nContext";

export function CostsImport({ storeId }: { storeId: string }) {
  const t = useT();
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
        {t(
          "CSV с две колони: SKU или EAN, след което цена (заглавен ред не е задължителен). Използва се за защитата на минималния марж — за продукти без въведена себестойност се прилага процент от текущата цена."
        )}
      </p>
      <input type="file" accept=".csv,text/csv" onChange={handleFile} disabled={importing} />
      {result && (
        <div className="small" style={{ marginTop: 8 }}>
          {t("Импортирани {count} реда.", { count: result.imported })}
          {result.errorCount > 0 && (
            <div className="error-text">
              {t("{count} ред(а) пропуснати: {errors}", { count: result.errorCount, errors: result.errors.join("; ") })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
