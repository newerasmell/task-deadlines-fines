import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { BrandRow } from "../api/types";
import { useStores } from "../context/StoreContext";

// Editable 1-10 coefficient for one brand — feeds codPricingEngine.ts's
// basePriceFor, which ranks this number against the coefficients of every
// other brand present in the same category to place a product's suggested
// base price inside that category's min/max range (Продажби tab).
function CoefficientCell({
  storeId,
  vendor,
  coefficient,
  onSaved,
}: {
  storeId: string;
  vendor: string;
  coefficient: number | null;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(coefficient != null ? String(coefficient) : "");
  const [saving, setSaving] = useState(false);

  async function save(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
      if (coefficient == null) return;
      setSaving(true);
      try {
        await api(`/brands/${storeId}/coefficient/${encodeURIComponent(vendor)}`, { method: "DELETE" });
        onSaved();
      } finally {
        setSaving(false);
      }
      return;
    }
    const n = Number(trimmed);
    if (Number.isNaN(n) || n < 1 || n > 10 || n === coefficient) return;
    setSaving(true);
    try {
      await api(`/brands/${storeId}/coefficient`, { method: "PUT", body: JSON.stringify({ vendor, coefficient: n }) });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <input
      className="suggested-input"
      type="number"
      step="1"
      min="1"
      max="10"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={(e) => save(e.target.value)}
      placeholder="—"
      disabled={saving}
      title="1 = най-евтин, 10 = най-скъп — сравнено с другите брандове в същата категория"
    />
  );
}

export function Brands() {
  const { currentStore } = useStores();
  const [rows, setRows] = useState<BrandRow[]>([]);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    if (!currentStore) return;
    const res = await api<BrandRow[]>(`/brands/${currentStore.id}`);
    setRows(res);
    setLoading(false);
  }

  useEffect(() => {
    setLoading(true);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStore?.id]);

  if (!currentStore) return <p className="muted">No store selected.</p>;
  if (loading) return <p className="center-loading">Loading…</p>;

  return (
    <div>
      <div className="page-header">
        <h1>Марки — {currentStore.name}</h1>
      </div>
      <p className="muted small" style={{ marginTop: -4, marginBottom: 12 }}>
        Ценови коефициент по бранд (1 = най-евтин, 10 = най-скъп). Използва се заедно с базовата цена min–max от
        Продажби, за да се генерира предложена "базова цена" за всеки продукт в Pricing.
      </p>

      <div className="table-wrap">
        <table className="pricing-table">
          <thead>
            <tr>
              <th>Бранд</th>
              <th># продукти</th>
              <th>Коефициент (1–10)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.vendor}>
                <td>{r.vendor}</td>
                <td>{r.productCount}</td>
                <td>
                  <CoefficientCell storeId={currentStore.id} vendor={r.vendor} coefficient={r.coefficient} onSaved={refresh} />
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="muted" style={{ textAlign: "center", padding: 30 }}>
                  Няма синхронизирани продукти още.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
