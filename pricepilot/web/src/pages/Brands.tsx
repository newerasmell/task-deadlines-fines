import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { BrandRow } from "../api/types";
import { useStores } from "../context/StoreContext";

// Clothing brands price the same everywhere, so instead of re-typing every
// vendor's 1-10 ranking on each new store, an admin sets it once and clones
// it onto whichever other stores also have this tab unlocked (Продажби +
// COD formula) — the same gate the nav link itself uses.
function CopyToStoresPanel({ storeId, brandCount }: { storeId: string; brandCount: number }) {
  const { stores, currentStore } = useStores();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [copying, setCopying] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const targets = stores.filter((s) => s.id !== storeId && s.salesAnalyticsEnabled && s.pricingProfile === "cod_formula");

  function toggle(id: string) {
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copy() {
    const targetStoreIds = [...checked];
    if (targetStoreIds.length === 0) return;
    const names = targets.filter((s) => checked.has(s.id)).map((s) => s.name);
    if (!window.confirm(`Копирай коефициентите на брандовете от "${currentStore?.name}" в: ${names.join(", ")}?\n\nТова ще презапише съществуващ коефициент за всеки споделен бранд в целевите магазини.`))
      return;
    setCopying(true);
    setError(null);
    setResult(null);
    try {
      const res = await api<{ copiedBrands: number; targetStoreCount: number }>(`/brands/${storeId}/copy-to`, {
        method: "POST",
        body: JSON.stringify({ targetStoreIds }),
      });
      setResult(`Копирани ${res.copiedBrands} бранда в ${res.targetStoreCount} магазин(а).`);
      setChecked(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Копирането се провали.");
    } finally {
      setCopying(false);
    }
  }

  if (targets.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div className="publish-settings-title">Копирай в други магазини</div>
      <p className="muted small" style={{ marginTop: -4, marginBottom: 10 }}>
        Приложи коефициентите на брандовете от този магазин ({brandCount}) към други магазини с отключен таб Марки
        (Продажби + COD формула).
      </p>
      <div className="publish-settings-rows">
        {targets.map((s) => (
          <label key={s.id} className="publish-setting-row" style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={checked.has(s.id)} onChange={() => toggle(s.id)} />
            <span className="publish-setting-label">
              {s.name} <span className="muted">({s.marketCode})</span>
            </span>
          </label>
        ))}
      </div>
      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
        <button className="small-btn" disabled={checked.size === 0 || copying} onClick={copy}>
          {copying ? "Копиране…" : `Копирай в ${checked.size} магазин(а)`}
        </button>
        {result && <span className="row-status-success">{result}</span>}
        {error && <span className="error-text">{error}</span>}
      </div>
    </div>
  );
}

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

      <CopyToStoresPanel storeId={currentStore.id} brandCount={rows.filter((r) => r.coefficient != null).length} />

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
