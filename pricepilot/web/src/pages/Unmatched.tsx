import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { PricingTableResponse, Source, UnmatchedRow } from "../api/types";
import { useStores } from "../context/StoreContext";

export function Unmatched() {
  const { currentStore } = useStores();
  const [sources, setSources] = useState<Source[]>([]);
  const [rows, setRows] = useState<UnmatchedRow[]>([]);
  const [products, setProducts] = useState<{ id: string; title: string }[]>([]);
  const [sourceFilter, setSourceFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [binding, setBinding] = useState<Record<string, string>>({}); // unmatchedRowId -> selected productId
  const [manualInput, setManualInput] = useState<Record<string, string>>({}); // unmatchedRowId -> pasted EAN/URL

  async function refresh() {
    if (!currentStore) return;
    const [unmatched, sourceList, pricing] = await Promise.all([
      api<UnmatchedRow[]>(`/unmatched/${currentStore.id}${sourceFilter ? `?sourceId=${sourceFilter}` : ""}`),
      api<Source[]>(`/sources?storeId=${currentStore.id}`),
      api<PricingTableResponse>(`/pricing/${currentStore.id}`),
    ]);
    setRows(unmatched);
    setSources(sourceList);
    setProducts(pricing.rows.map((r) => ({ id: r.productId, title: r.title })));
    setLoading(false);
  }

  useEffect(() => {
    setLoading(true);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStore?.id, sourceFilter]);

  async function bindByProductSelect(row: UnmatchedRow) {
    const productId = binding[row.id];
    if (!productId || !currentStore) return;
    await api("/unmatched/manual-match", {
      method: "POST",
      body: JSON.stringify({
        storeId: currentStore.id,
        sourceId: row.sourceId,
        productId,
        competitorUrlOrEan: row.url ?? row.matchKey,
        unmatchedCompetitorPriceId: row.id,
      }),
    });
    refresh();
  }

  async function bindByManualText(productId: string, sourceId: string, rowId: string) {
    const text = manualInput[rowId];
    if (!text || !currentStore) return;
    await api("/unmatched/manual-match", {
      method: "POST",
      body: JSON.stringify({ storeId: currentStore.id, sourceId, productId, competitorUrlOrEan: text }),
    });
    refresh();
  }

  if (!currentStore) return <p className="muted">No store selected.</p>;
  if (loading) return <p className="center-loading">Loading…</p>;

  return (
    <div>
      <div className="page-header">
        <h1>Unmatched — {currentStore.name}</h1>
      </div>
      <p className="muted">
        Competitor listings that couldn't be matched to a product by EAN or by normalized brand+name+ml. Bind one manually
        below — manual bindings always take priority over automatic matching on future refreshes.
      </p>

      <div className="filters-bar">
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
          <option value="">All sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="entity-list">
        {rows.map((row) => (
          <div key={row.id} className="entity-row">
            <div>
              <strong>{row.competitorTitle ?? row.matchKey}</strong>{" "}
              <span className="muted small">
                ({row.sourceLabel} · {row.price.toFixed(2)} {row.currency}
                {row.competitorBarcode ? ` · EAN ${row.competitorBarcode}` : ""})
              </span>
              {row.url && (
                <div>
                  <a href={row.url} target="_blank" rel="noreferrer" className="small">
                    {row.url}
                  </a>
                </div>
              )}
            </div>
            <div className="entity-row-actions" style={{ flexDirection: "column", alignItems: "stretch", minWidth: 260 }}>
              <div className="form-row" style={{ margin: 0 }}>
                <select
                  value={binding[row.id] ?? ""}
                  onChange={(e) => setBinding((cur) => ({ ...cur, [row.id]: e.target.value }))}
                >
                  <option value="">Bind to product…</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
                <button className="small-btn" onClick={() => bindByProductSelect(row)} disabled={!binding[row.id]}>
                  Bind
                </button>
              </div>
              <div className="form-row" style={{ margin: 0 }}>
                <input
                  placeholder="or paste competitor URL / EAN for a specific product"
                  value={manualInput[row.id] ?? ""}
                  onChange={(e) => setManualInput((cur) => ({ ...cur, [row.id]: e.target.value }))}
                />
                <button
                  className="small-btn secondary"
                  onClick={() => bindByManualText(binding[row.id], row.sourceId, row.id)}
                  disabled={!binding[row.id] || !manualInput[row.id]}
                  title="Pick a product above first, then confirm the URL/EAN"
                >
                  Confirm
                </button>
              </div>
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className="muted">Nothing unmatched right now.</p>}
      </div>
    </div>
  );
}
