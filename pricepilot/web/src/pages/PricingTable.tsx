import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { PricingRow, PricingTableResponse, PublishResultItem, RowFlag } from "../api/types";
import { useStores } from "../context/StoreContext";

const FLAG_LABELS: Record<RowFlag, string> = {
  "above-market": "Above market",
  competitive: "Competitive",
  "below-market": "Below market",
  "below-floor": "Below floor",
  "no-data": "No data",
};

type SortKey = "title" | "ourPrice" | "minComp" | "deltaPct" | "suggested" | "matchedSourceCount";
type RowStatus = { state: "idle" } | { state: "pending" } | { state: "success" } | { state: "error"; message: string };

function fmtMoney(v: number | null, currency: string): string {
  if (v == null) return "—";
  return `${v.toFixed(2)} ${currency}`;
}

function fmtFreshness(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function PricingTable() {
  const { currentStore } = useStores();
  const [data, setData] = useState<PricingTableResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [flagFilter, setFlagFilter] = useState<RowFlag | "">("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [search, setSearch] = useState("");
  const [minDeltaPct, setMinDeltaPct] = useState("");
  const [coverageFilter, setCoverageFilter] = useState<"" | "3" | "2" | "1" | "0">("");

  const [sortKey, setSortKey] = useState<SortKey>("title");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edited, setEdited] = useState<Map<string, number>>(new Map());
  const [rowStatus, setRowStatus] = useState<Map<string, RowStatus>>(new Map());
  const [setCompareAt, setSetCompareAt] = useState(true);
  const [skipSingleConfirm, setSkipSingleConfirm] = useState(() => localStorage.getItem("pp.skipSingleConfirm") === "1");
  const [bulkPublishing, setBulkPublishing] = useState(false);

  async function refresh() {
    if (!currentStore) return;
    setError(null);
    try {
      const res = await api<PricingTableResponse>(`/pricing/${currentStore.id}`);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load pricing table");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStore?.id]);

  useEffect(() => {
    localStorage.setItem("pp.skipSingleConfirm", skipSingleConfirm ? "1" : "0");
  }, [skipSingleConfirm]);

  const vendors = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.rows.map((r) => r.vendor).filter((v): v is string => Boolean(v)))).sort();
  }, [data]);

  const filteredSortedRows = useMemo(() => {
    if (!data) return [];
    let rows = data.rows;
    if (flagFilter) rows = rows.filter((r) => r.flag === flagFilter);
    if (vendorFilter) rows = rows.filter((r) => r.vendor === vendorFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(
        (r) => r.title.toLowerCase().includes(q) || r.sku?.toLowerCase().includes(q) || r.barcode?.toLowerCase().includes(q)
      );
    }
    if (minDeltaPct.trim() && !Number.isNaN(Number(minDeltaPct))) {
      const min = Number(minDeltaPct);
      rows = rows.filter((r) => r.deltaPct != null && r.deltaPct > min);
    }
    if (coverageFilter !== "") {
      rows = rows.filter((r) => r.matchedSourceCount === Number(coverageFilter));
    }

    const dir = sortDir;
    const sorted = [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return ((av as number) - (bv as number)) * dir;
    });
    return sorted;
  }, [data, flagFilter, vendorFilter, search, minDeltaPct, coverageFilter, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  }

  function suggestedFor(row: PricingRow): number | null {
    return edited.get(row.productId) ?? row.suggested;
  }

  function setSuggestedValue(productId: string, value: string) {
    const num = Number(value);
    setEdited((cur) => {
      const next = new Map(cur);
      if (value === "" || Number.isNaN(num)) next.delete(productId);
      else next.set(productId, num);
      return next;
    });
  }

  function toggleRow(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll(select: boolean) {
    setSelected(select ? new Set(filteredSortedRows.map((r) => r.productId)) : new Set());
  }

  async function doPublish(items: { productId: string; newPrice: number }[], mode: "single" | "bulk") {
    if (!currentStore) return;
    setRowStatus((cur) => {
      const next = new Map(cur);
      for (const i of items) next.set(i.productId, { state: "pending" });
      return next;
    });
    try {
      const res = await api<{ results: PublishResultItem[] }>("/publish", {
        method: "POST",
        body: JSON.stringify({
          storeId: currentStore.id,
          mode,
          items: items.map((i) => ({ productId: i.productId, newPrice: i.newPrice, setCompareAt })),
        }),
      });
      setRowStatus((cur) => {
        const next = new Map(cur);
        for (const r of res.results) {
          next.set(r.productId, r.status === "SUCCESS" ? { state: "success" } : { state: "error", message: r.errorMessage ?? "Failed" });
        }
        return next;
      });
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Publish failed";
      setRowStatus((cur) => {
        const next = new Map(cur);
        for (const i of items) next.set(i.productId, { state: "error", message });
        return next;
      });
    }
  }

  function publishSingle(row: PricingRow) {
    const price = suggestedFor(row);
    if (price == null) return;
    if (!skipSingleConfirm && !window.confirm(`Publish ${price.toFixed(2)} ${currentStore?.currency} for "${row.title}"?`)) return;
    doPublish([{ productId: row.productId, newPrice: price }], "single");
  }

  async function publishSelected() {
    const items = filteredSortedRows
      .filter((r) => selected.has(r.productId))
      .map((r) => ({ productId: r.productId, newPrice: suggestedFor(r) }))
      .filter((i): i is { productId: string; newPrice: number } => i.newPrice != null);
    if (items.length === 0) return;
    const total = items.reduce((s, i) => s + i.newPrice, 0);
    if (!window.confirm(`Publish ${items.length} selected products (total new price sum ${total.toFixed(2)} ${currentStore?.currency})?`))
      return;
    setBulkPublishing(true);
    try {
      await doPublish(items, "bulk");
      setSelected(new Set());
    } finally {
      setBulkPublishing(false);
    }
  }

  async function togglePriority(row: PricingRow) {
    await api(`/pricing/product/${row.productId}/priority`, { method: "PATCH", body: JSON.stringify({ priority: !row.priority }) });
    refresh();
  }

  if (!currentStore) {
    return (
      <div>
        <p className="muted">No store selected yet — add one under Settings.</p>
      </div>
    );
  }
  if (loading) return <p className="center-loading">Loading…</p>;
  if (error) return <p className="error-text">{error}</p>;
  if (!data) return null;

  const allVisibleSelected = filteredSortedRows.length > 0 && filteredSortedRows.every((r) => selected.has(r.productId));

  return (
    <div>
      <div className="page-header">
        <h1>Pricing — {currentStore.name}</h1>
        <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={setCompareAt} onChange={(e) => setSetCompareAt(e.target.checked)} />
          Set old price as compare-at
        </label>
      </div>

      <div className="filters-bar">
        <input placeholder="Search name / SKU / EAN" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={flagFilter} onChange={(e) => setFlagFilter(e.target.value as RowFlag | "")}>
          <option value="">All statuses</option>
          {(Object.keys(FLAG_LABELS) as RowFlag[]).map((f) => (
            <option key={f} value={f}>
              {FLAG_LABELS[f]}
            </option>
          ))}
        </select>
        <select value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)}>
          <option value="">All brands</option>
          {vendors.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <input
          type="number"
          placeholder="Δ% > "
          value={minDeltaPct}
          onChange={(e) => setMinDeltaPct(e.target.value)}
          style={{ width: 90 }}
        />
        <select value={coverageFilter} onChange={(e) => setCoverageFilter(e.target.value as "" | "3" | "2" | "1" | "0")}>
          <option value="">Any coverage</option>
          <option value="3">Matched in 3 sources</option>
          <option value="2">Matched in 2 sources</option>
          <option value="1">Matched in 1 source</option>
          <option value="0">Matched in 0 sources</option>
        </select>
        <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={skipSingleConfirm} onChange={(e) => setSkipSingleConfirm(e.target.checked)} />
          Don't ask again for single publishes
        </label>
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar">
          <span>{selected.size} selected</span>
          <span className="spacer" />
          <button onClick={publishSelected} disabled={bulkPublishing}>
            {bulkPublishing ? "Publishing…" : `Publish ${selected.size} selected`}
          </button>
          <button className="secondary" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      <div className="table-wrap">
        <table className="pricing-table">
          <thead>
            <tr>
              <th>
                <input type="checkbox" checked={allVisibleSelected} onChange={(e) => toggleSelectAll(e.target.checked)} />
              </th>
              <th className={sortKey === "title" ? "sorted" : ""} onClick={() => toggleSort("title")}>
                Product
              </th>
              <th className={sortKey === "ourPrice" ? "sorted" : ""} onClick={() => toggleSort("ourPrice")}>
                Our price
              </th>
              <th>Compare-at</th>
              {data.sources.map((s) => (
                <th key={s.id}>
                  {s.label}
                  {s.degraded && <span className="tag" title={`Degraded — check Settings`}>!</span>}
                </th>
              ))}
              <th className={sortKey === "minComp" ? "sorted" : ""} onClick={() => toggleSort("minComp")}>
                Min
              </th>
              <th className={sortKey === "deltaPct" ? "sorted" : ""} onClick={() => toggleSort("deltaPct")}>
                Δ% vs min
              </th>
              <th className={sortKey === "suggested" ? "sorted" : ""} onClick={() => toggleSort("suggested")}>
                Suggested
              </th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filteredSortedRows.map((row) => {
              const status = rowStatus.get(row.productId) ?? { state: "idle" as const };
              const suggestedValue = suggestedFor(row);
              return (
                <tr key={row.productId}>
                  <td>
                    <input type="checkbox" checked={selected.has(row.productId)} onChange={() => toggleRow(row.productId)} />
                  </td>
                  <td>
                    <div className="product-cell">
                      {row.imageUrl ? (
                        <img src={row.imageUrl} className="product-thumb" alt="" />
                      ) : (
                        <div className="product-thumb" />
                      )}
                      <div>
                        <div className="product-title">
                          {row.title}
                          {row.priority && <span className="tag" title="Always scraped every run">★</span>}
                        </div>
                        <div className="product-sku">
                          {row.sku ?? "—"} {row.barcode ? `· ${row.barcode}` : ""}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td>{fmtMoney(row.ourPrice, currentStore.currency)}</td>
                  <td>{fmtMoney(row.compareAtPrice, currentStore.currency)}</td>
                  {data.sources.map((s) => {
                    const cell = row.sourcePrices[s.id];
                    return (
                      <td key={s.id} className={`source-cell${cell?.stale ? " stale" : ""}`}>
                        {cell ? (
                          <a href={cell.url ?? undefined} target="_blank" rel="noreferrer" title={cell.url ?? undefined}>
                            {fmtMoney(cell.price, cell.currency)}
                            <div className="small">
                              {fmtFreshness(cell.fetchedAt)} {cell.stale && "⚠️"}
                            </div>
                          </a>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    );
                  })}
                  <td>{fmtMoney(row.minComp, currentStore.currency)}</td>
                  <td>{row.deltaPct != null ? `${row.deltaPct > 0 ? "+" : ""}${row.deltaPct.toFixed(1)}%` : "—"}</td>
                  <td>
                    <input
                      className="suggested-input"
                      type="number"
                      step="0.01"
                      value={suggestedValue ?? ""}
                      onChange={(e) => setSuggestedValue(row.productId, e.target.value)}
                      placeholder="—"
                    />
                    <div>
                      <span className={`badge flag-${row.flag}`}>{FLAG_LABELS[row.flag]}</span>
                    </div>
                  </td>
                  <td>
                    {status.state === "pending" && <span className="row-status-spinner">Publishing…</span>}
                    {status.state === "success" && <span className="row-status-success">✓ Published</span>}
                    {status.state === "error" && (
                      <Link to="/publish-log" className="row-status-error" title={status.message}>
                        ✕ Error
                      </Link>
                    )}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 6, flexDirection: "column" }}>
                      <button
                        className="small-btn"
                        onClick={() => publishSingle(row)}
                        disabled={suggestedValue == null || status.state === "pending"}
                      >
                        Publish
                      </button>
                      <button className="small-btn secondary" onClick={() => togglePriority(row)}>
                        {row.priority ? "Unflag priority" : "Flag priority"}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filteredSortedRows.length === 0 && (
              <tr>
                <td colSpan={9 + data.sources.length} className="muted" style={{ textAlign: "center", padding: 30 }}>
                  No products match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
