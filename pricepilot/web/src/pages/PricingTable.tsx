import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type {
  CodBracketInput,
  CodFormulaInfo,
  CodFormulaMode,
  CodScenarioInput,
  PricingRow,
  PricingTableResponse,
  PublishResultItem,
  RowFlag,
} from "../api/types";
import { useStores } from "../context/StoreContext";

const FLAG_LABELS: Record<RowFlag, string> = {
  "above-market": "Above market",
  competitive: "Competitive",
  "below-market": "Below market",
  "below-floor": "Below floor",
  "no-data": "No data",
};

type SortKey = "title" | "ourPrice" | "minComp" | "deltaPct" | "suggested" | "matchedSourceCount" | "activatedAt";
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

// Product.activatedAt — the sync's own stamp of the first time it ever saw
// this variant ACTIVE in Shopify, not "uploaded"/created — see
// catalogSync.ts. Shown as an actual date plus a day-count, since "8 days
// ago" alone doesn't answer "on what date".
function fmtActivatedAt(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  const days = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
  return `${date.toLocaleDateString()} (${days}d)`;
}

type ViewMode = "table" | "cards";

// The price a product is at right now vs. what the engine suggests it
// should be is the single most important comparison on this page — it
// used to blend in as just another field among a dozen others (both in
// the old table's columns and the card's field grid), making it hard to
// tell at a glance which number was "current" and which was "proposed".
// Pulled out into its own emphasized block, used identically by both the
// table and card layouts below.
function PriceCompare({
  row,
  currency,
  isCod,
  suggestedValue,
  onSuggestedChange,
}: {
  row: PricingRow;
  currency: string;
  isCod: boolean;
  suggestedValue: number | null;
  onSuggestedChange: (value: string) => void;
}) {
  return (
    <div className="price-compare">
      <div className="price-compare-current">
        <span className="field-label">Our price</span>
        <span className="price-compare-value">{fmtMoney(row.ourPrice, currency)}</span>
      </div>
      <span className="price-compare-arrow">→</span>
      <div className={`price-compare-suggested flag-${row.flag}`}>
        <span className="field-label">{isCod ? "Recommended" : "Suggested"}</span>
        <input
          className="suggested-input-big"
          type="number"
          step="0.01"
          value={suggestedValue ?? ""}
          onChange={(e) => onSuggestedChange(e.target.value)}
          placeholder="—"
        />
        <span className={`badge flag-${row.flag}`}>{FLAG_LABELS[row.flag]}</span>
      </div>
    </div>
  );
}

export function PricingTable() {
  const { currentStore } = useStores();
  const [data, setData] = useState<PricingTableResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [viewMode, setViewMode] = useState<ViewMode>(() => (localStorage.getItem("pp.pricingView") as ViewMode) || "table");
  const [flagFilter, setFlagFilter] = useState<RowFlag | "">("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [search, setSearch] = useState("");
  const [minDeltaPct, setMinDeltaPct] = useState("");
  const [coverageFilter, setCoverageFilter] = useState<"" | "3" | "2" | "1" | "0">("");
  const [markdownOnly, setMarkdownOnly] = useState(false);

  const [sortKey, setSortKey] = useState<SortKey>("title");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edited, setEdited] = useState<Map<string, number>>(new Map());
  const [rowStatus, setRowStatus] = useState<Map<string, RowStatus>>(new Map());
  // Off by default: silently overwriting compare-at on every publish is
  // surprising — confirmed live it can leave a product's compare-at LOWER
  // than its new price (e.g. raising 141 -> 142 with this on sets
  // compare-at to the old 141, replacing whatever real reference price
  // — 252.10 in that case — was there before). Opt-in only.
  const [setCompareAt, setSetCompareAt] = useState(false);
  const [skipSingleConfirm, setSkipSingleConfirm] = useState(() => localStorage.getItem("pp.skipSingleConfirm") === "1");
  const [bulkPublishing, setBulkPublishing] = useState(false);
  const [costDraft, setCostDraft] = useState<Map<string, string>>(new Map());
  const [costSaving, setCostSaving] = useState<Set<string>>(new Set());
  // Which empty source cell currently has its manual-entry form open — at
  // most one at a time, keyed by "productId:sourceId" since a cell is empty
  // per (product, source) pair, not per product alone.
  const [manualEntryOpen, setManualEntryOpen] = useState<string | null>(null);
  const [manualPrice, setManualPrice] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

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

  useEffect(() => {
    localStorage.setItem("pp.pricingView", viewMode);
  }, [viewMode]);

  const vendors = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.rows.map((r) => r.vendor).filter((v): v is string => Boolean(v)))).sort();
  }, [data]);

  const filteredSortedRows = useMemo(() => {
    if (!data) return [];
    let rows = data.rows;
    if (flagFilter) rows = rows.filter((r) => r.flag === flagFilter);
    if (vendorFilter) rows = rows.filter((r) => r.vendor === vendorFilter);
    if (categoryFilter) rows = rows.filter((r) => r.categoryIds.includes(categoryFilter));
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
    if (markdownOnly) rows = rows.filter((r) => r.markdownEligible);

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
  }, [data, flagFilter, vendorFilter, categoryFilter, search, minDeltaPct, coverageFilter, markdownOnly, sortKey, sortDir]);

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

  async function doPublish(items: { productId: string; newPrice: number; newCompareAtPrice?: number | null }[], mode: "single" | "bulk") {
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
          items: items.map((i) => ({ productId: i.productId, newPrice: i.newPrice, setCompareAt, newCompareAtPrice: i.newCompareAtPrice })),
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
    doPublish([{ productId: row.productId, newPrice: price, newCompareAtPrice: row.recommendedComparePrice }], "single");
  }

  async function publishSelected() {
    const items = filteredSortedRows
      .filter((r) => selected.has(r.productId))
      .map((r) => ({ productId: r.productId, newPrice: suggestedFor(r), newCompareAtPrice: r.recommendedComparePrice }))
      .filter((i): i is { productId: string; newPrice: number; newCompareAtPrice: number | null } => i.newPrice != null);
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

  function openManualEntry(productId: string, sourceId: string, existing?: { price: number; url: string | null }) {
    setManualEntryOpen(`${productId}:${sourceId}`);
    setManualPrice(existing ? String(existing.price) : "");
    setManualUrl(existing?.url ?? "");
    setManualError(null);
  }

  async function saveManualEntry(productId: string, sourceId: string) {
    const price = Number(manualPrice);
    if (!manualPrice.trim() || Number.isNaN(price) || price <= 0) {
      setManualError("Enter a valid price");
      return;
    }
    if (!manualUrl.trim()) {
      setManualError("Enter the listing URL");
      return;
    }
    setManualSaving(true);
    setManualError(null);
    try {
      await api(`/sources/${sourceId}/manual-entry`, {
        method: "POST",
        body: JSON.stringify({ productId, price, url: manualUrl.trim() }),
      });
      setManualEntryOpen(null);
      refresh();
    } catch (err) {
      setManualError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setManualSaving(false);
    }
  }

  function costFor(row: PricingRow): string {
    return costDraft.has(row.productId) ? costDraft.get(row.productId)! : row.cost != null ? String(row.cost) : "";
  }

  async function saveCost(row: PricingRow, value: string) {
    const num = Number(value);
    if (!value.trim() || Number.isNaN(num) || num <= 0) return;
    setCostSaving((cur) => new Set(cur).add(row.productId));
    try {
      await api(`/costs/product/${row.productId}`, { method: "PATCH", body: JSON.stringify({ cost: num }) });
      setCostDraft((cur) => {
        const next = new Map(cur);
        next.delete(row.productId);
        return next;
      });
      await refresh();
    } finally {
      setCostSaving((cur) => {
        const next = new Set(cur);
        next.delete(row.productId);
        return next;
      });
    }
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

  const isCod = currentStore.pricingProfile === "cod_formula";
  const allVisibleSelected = filteredSortedRows.length > 0 && filteredSortedRows.every((r) => selected.has(r.productId));

  // Shared between the table and card layouts below so the two views can
  // never quietly drift apart on what a cell/field actually shows.
  function renderProductHead(row: PricingRow) {
    return (
      <>
        {row.imageUrl ? <img src={row.imageUrl} className="product-thumb" alt="" /> : <div className="product-thumb" />}
        <div>
          <div className="product-title">
            {row.title}
            {row.priority && <span className="tag" title="Always scraped every run">★</span>}
            {isCod && row.discountTagged && (
              <span className="tag" title={`Tagged "${data!.formula?.config.discountTag}" in Shopify`}>
                намален
              </span>
            )}
            {isCod && row.markdownEligible && (
              <span className="tag" title={`${row.daysSinceActive} дни от "active" — цена над таван, готов за намаляване`}>
                🔻 markdown
              </span>
            )}
          </div>
          <div className="product-sku">
            {row.sku ?? "—"} {row.barcode ? `· ${row.barcode}` : ""}
          </div>
          {isCod && row.tags.length > 0 && <div className="small muted">{row.tags.join(", ")}</div>}
        </div>
      </>
    );
  }

  function renderCostInput(row: PricingRow) {
    return (
      <input
        className="suggested-input"
        type="number"
        step="0.01"
        min="0"
        value={costFor(row)}
        onChange={(e) => setCostDraft((cur) => new Map(cur).set(row.productId, e.target.value))}
        onBlur={(e) => saveCost(row, e.target.value)}
        placeholder="—"
        disabled={costSaving.has(row.productId)}
        title="Себестойност (покупна цена) — Cost.csv импорт или ръчно тук"
      />
    );
  }

  function renderSourceCell(row: PricingRow, s: PricingTableResponse["sources"][number]) {
    const cell = row.sourcePrices[s.id];
    const cellKey = `${row.productId}:${s.id}`;
    const isEditing = manualEntryOpen === cellKey;
    if (isEditing) {
      return (
        <div className="manual-entry-form">
          <input
            type="number"
            step="0.01"
            min="0"
            placeholder={`Price (${currentStore!.currency})`}
            value={manualPrice}
            onChange={(e) => setManualPrice(e.target.value)}
            autoFocus
          />
          <input type="text" placeholder="Listing URL" value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} />
          {manualError && <div className="small row-status-error">{manualError}</div>}
          <div className="manual-entry-actions">
            <button className="small-btn" onClick={() => saveManualEntry(row.productId, s.id)} disabled={manualSaving}>
              Save
            </button>
            <button className="small-btn secondary" onClick={() => setManualEntryOpen(null)} disabled={manualSaving}>
              Cancel
            </button>
          </div>
        </div>
      );
    }
    if (cell) {
      return (
        <>
          <a href={cell.url ?? undefined} target="_blank" rel="noreferrer" title={cell.url ?? undefined}>
            {fmtMoney(cell.price, cell.currency)}
            <div className="small">
              {fmtFreshness(cell.fetchedAt)} {cell.stale && "⚠️"}
            </div>
          </a>
          {cell.isManual && (
            <div className="manual-badge-row">
              <span className="badge manual-badge" title="Entered by hand, not from an automated source">
                Manual
              </span>
              <button
                className="edit-manual-btn"
                onClick={() => openManualEntry(row.productId, s.id, { price: cell.price, url: cell.url })}
                title="Edit this manual entry"
              >
                ✎
              </button>
            </div>
          )}
        </>
      );
    }
    return (
      <button className="add-manually-btn" onClick={() => openManualEntry(row.productId, s.id)} title={`Add a ${s.label} price manually`}>
        + Add
      </button>
    );
  }

  function renderActions(row: PricingRow, status: RowStatus, suggestedValue: number | null) {
    return (
      <>
        <button className="small-btn" onClick={() => publishSingle(row)} disabled={suggestedValue == null || status.state === "pending"}>
          Publish
        </button>
        <button className="small-btn secondary" onClick={() => togglePriority(row)}>
          {row.priority ? "Unflag priority" : "Flag priority"}
        </button>
      </>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>Pricing — {currentStore.name}</h1>
      </div>

      {isCod && <CodFormulaPanel storeId={currentStore.id} formula={data.formula} currency={currentStore.currency} onSaved={refresh} />}

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
        {data.categories.length > 0 && (
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">All categories</option>
            {data.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        )}
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
        {isCod && (
          <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={markdownOnly} onChange={(e) => setMarkdownOnly(e.target.checked)} />
            Само за намаляване
          </label>
        )}
      </div>

      <PublishSettings
        isCod={isCod}
        setCompareAt={setCompareAt}
        onSetCompareAtChange={setSetCompareAt}
        skipSingleConfirm={skipSingleConfirm}
        onSkipSingleConfirmChange={setSkipSingleConfirm}
      />

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

      <div className="pricing-toolbar">
        <label className="select-all-row">
          <input type="checkbox" checked={allVisibleSelected} onChange={(e) => toggleSelectAll(e.target.checked)} />
          Select all ({filteredSortedRows.length})
        </label>
        <div className="sort-control">
          <span className="muted small">Sort by</span>
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
            <option value="title">Product</option>
            <option value="ourPrice">Our price</option>
            <option value="activatedAt">Active от</option>
            {!isCod && <option value="minComp">Min</option>}
            <option value="deltaPct">{isCod ? "Δ% vs recommended" : "Δ% vs min"}</option>
            <option value="suggested">{isCod ? "Recommended" : "Suggested"}</option>
            {!isCod && <option value="matchedSourceCount">Coverage</option>}
          </select>
          <button type="button" className="small-btn secondary" onClick={() => setSortDir((d) => (d === 1 ? -1 : 1))}>
            {sortDir === 1 ? "↑ Asc" : "↓ Desc"}
          </button>
        </div>
        <div className="view-toggle">
          <button type="button" className={`small-btn${viewMode === "table" ? "" : " secondary"}`} onClick={() => setViewMode("table")}>
            Таблица
          </button>
          <button type="button" className={`small-btn${viewMode === "cards" ? "" : " secondary"}`} onClick={() => setViewMode("cards")}>
            Карти
          </button>
        </div>
      </div>

      {viewMode === "table" ? (
        <div className="table-wrap">
          <table className="pricing-table pricing-table-compact">
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={allVisibleSelected} onChange={(e) => toggleSelectAll(e.target.checked)} />
                </th>
                <th>Product</th>
                <th>Price</th>
                <th>Compare-at</th>
                <th>Active от</th>
                {isCod && <th>Cost</th>}
                {data.sources.map((s) => (
                  <th key={s.id}>
                    {s.label}
                    {s.degraded && <span className="tag" title="Degraded — check Settings">!</span>}
                  </th>
                ))}
                {!isCod && <th>Min</th>}
                <th>{isCod ? "Δ% vs recommended" : "Δ% vs min"}</th>
                {isCod && <th>Recommended compare-at</th>}
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
                      <div className="table-product-cell">{renderProductHead(row)}</div>
                    </td>
                    <td>
                      <PriceCompare
                        row={row}
                        currency={currentStore.currency}
                        isCod={isCod}
                        suggestedValue={suggestedValue}
                        onSuggestedChange={(v) => setSuggestedValue(row.productId, v)}
                      />
                    </td>
                    <td>{fmtMoney(row.compareAtPrice, currentStore.currency)}</td>
                    <td className="small">{fmtActivatedAt(row.activatedAt)}</td>
                    {isCod && <td>{renderCostInput(row)}</td>}
                    {data.sources.map((s) => (
                      <td key={s.id} className={`source-cell${row.sourcePrices[s.id]?.stale ? " stale" : ""}`}>
                        {renderSourceCell(row, s)}
                      </td>
                    ))}
                    {!isCod && <td>{fmtMoney(row.minComp, currentStore.currency)}</td>}
                    <td>{row.deltaPct != null ? `${row.deltaPct > 0 ? "+" : ""}${row.deltaPct.toFixed(1)}%` : "—"}</td>
                    {isCod && (
                      <td title={row.recommendedComparePrice == null ? row.recommendedComparePriceReason ?? undefined : undefined}>
                        {fmtMoney(row.recommendedComparePrice, currentStore.currency)}
                      </td>
                    )}
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
                      <div style={{ display: "flex", gap: 6, flexDirection: "column" }}>{renderActions(row, status, suggestedValue)}</div>
                    </td>
                  </tr>
                );
              })}
              {filteredSortedRows.length === 0 && (
                <tr>
                  <td colSpan={8 + data.sources.length + (isCod ? 2 : 1)} className="muted" style={{ textAlign: "center", padding: 30 }}>
                    No products match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="pricing-cards">
          {filteredSortedRows.map((row) => {
            const status = rowStatus.get(row.productId) ?? { state: "idle" as const };
            const suggestedValue = suggestedFor(row);
            return (
              <div className="pricing-card" key={row.productId}>
                <div className="pricing-card-head">
                  <input type="checkbox" checked={selected.has(row.productId)} onChange={() => toggleRow(row.productId)} />
                  <div className="pricing-card-head-info">{renderProductHead(row)}</div>
                </div>

                <PriceCompare
                  row={row}
                  currency={currentStore.currency}
                  isCod={isCod}
                  suggestedValue={suggestedValue}
                  onSuggestedChange={(v) => setSuggestedValue(row.productId, v)}
                />

                <div className="pricing-card-fields">
                  <div className="field">
                    <span className="field-label">Compare-at</span>
                    <span className="field-value">{fmtMoney(row.compareAtPrice, currentStore.currency)}</span>
                  </div>
                  <div className="field">
                    <span className="field-label">Active от</span>
                    <span className="field-value small">{fmtActivatedAt(row.activatedAt)}</span>
                  </div>
                  {isCod && (
                    <div className="field">
                      <span className="field-label">Cost</span>
                      {renderCostInput(row)}
                    </div>
                  )}
                  {!isCod && (
                    <div className="field">
                      <span className="field-label">Min</span>
                      <span className="field-value">{fmtMoney(row.minComp, currentStore.currency)}</span>
                    </div>
                  )}
                  <div className="field">
                    <span className="field-label">{isCod ? "Δ% vs recommended" : "Δ% vs min"}</span>
                    <span className="field-value">{row.deltaPct != null ? `${row.deltaPct > 0 ? "+" : ""}${row.deltaPct.toFixed(1)}%` : "—"}</span>
                  </div>
                  {isCod && (
                    <div className="field" title={row.recommendedComparePrice == null ? row.recommendedComparePriceReason ?? undefined : undefined}>
                      <span className="field-label">Recommended compare-at</span>
                      <span className="field-value">{fmtMoney(row.recommendedComparePrice, currentStore.currency)}</span>
                    </div>
                  )}
                </div>

                {data.sources.length > 0 && (
                  <div className="pricing-card-sources">
                    {data.sources.map((s) => (
                      <div key={s.id} className={`field source-cell${row.sourcePrices[s.id]?.stale ? " stale" : ""}`}>
                        <span className="field-label">
                          {s.label}
                          {s.degraded && <span className="tag" title="Degraded — check Settings">!</span>}
                        </span>
                        {renderSourceCell(row, s)}
                      </div>
                    ))}
                  </div>
                )}

                <div className="pricing-card-footer">
                  <div>
                    {status.state === "pending" && <span className="row-status-spinner">Publishing…</span>}
                    {status.state === "success" && <span className="row-status-success">✓ Published</span>}
                    {status.state === "error" && (
                      <Link to="/publish-log" className="row-status-error" title={status.message}>
                        ✕ Error
                      </Link>
                    )}
                  </div>
                  <div className="pricing-card-actions">{renderActions(row, status, suggestedValue)}</div>
                </div>
              </div>
            );
          })}
          {filteredSortedRows.length === 0 && (
            <p className="muted" style={{ textAlign: "center", padding: 30, gridColumn: "1 / -1" }}>
              No products match these filters.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// Both toggles used to live in unrelated corners of the page (one next to
// the page title, one stuffed at the end of the filters bar), so it wasn't
// obvious they were "publish behavior" settings at all, let alone what each
// one actually did or when it applied. One labeled block, directly above
// the table whose Publish buttons it affects, with the exact behavior spelled
// out instead of only a hover tooltip.
function PublishSettings({
  isCod,
  setCompareAt,
  onSetCompareAtChange,
  skipSingleConfirm,
  onSkipSingleConfirmChange,
}: {
  isCod: boolean;
  setCompareAt: boolean;
  onSetCompareAtChange: (v: boolean) => void;
  skipSingleConfirm: boolean;
  onSkipSingleConfirmChange: (v: boolean) => void;
}) {
  return (
    <div className="card publish-settings" style={{ marginBottom: 14 }}>
      <div className="publish-settings-title">Publish settings</div>
      <div className="publish-settings-rows">
        {!isCod && (
          <label className="publish-setting-row">
            <input type="checkbox" checked={setCompareAt} onChange={(e) => onSetCompareAtChange(e.target.checked)} />
            <span>
              <span className="publish-setting-label">Set compare-at to the pre-publish price</span>
              <span className="publish-setting-desc">
                Applies to every publish below (single row or bulk) while this checkbox is on. Off by default —
                confirmed live it can leave compare-at <em>lower</em> than the new price if you're raising it, which
                replaces whatever real reference price was there before.
              </span>
            </span>
          </label>
        )}
        <label className="publish-setting-row">
          <input type="checkbox" checked={skipSingleConfirm} onChange={(e) => onSkipSingleConfirmChange(e.target.checked)} />
          <span>
            <span className="publish-setting-label">Skip the confirmation popup</span>
            <span className="publish-setting-desc">
              Only for a single row's own "Publish" button — publishing several selected rows at once always asks
              first regardless of this. Remembered on this device/browser only.
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}

const SCENARIO_KEY_LABELS: Record<string, string> = { pess: "Песимистичен", avg: "Среден", opt: "Оптимистичен" };
const MODE_LABELS: Record<CodFormulaMode, string> = { cost: "Себестойност", target: "Целева печалба", breakeven: "Break-even" };

function fmtK(v: number | null): string {
  return v !== null && isFinite(v) ? v.toFixed(3) : "—";
}

function CodFormulaPanel({
  storeId,
  formula,
  currency,
  onSaved,
}: {
  storeId: string;
  formula: CodFormulaInfo | null;
  currency: string;
  onSaved: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState<CodFormulaMode>("target");
  const [cogsPct, setCogsPct] = useState("40");
  const [fRate, setFRate] = useState("5");
  const [mRate, setMRate] = useState("10");
  const [nItems, setNItems] = useState("1.3");
  const [rMult, setRMult] = useState("2");
  const [lLoss, setLLoss] = useState("0");
  const [fCost, setFCost] = useState("5000");
  const [roundStep, setRoundStep] = useState("1");
  const [discountPct, setDiscountPct] = useState("50");
  const [discountTag, setDiscountTag] = useState("sale");
  const [pricingScenario, setPricingScenario] = useState("avg");
  const [pricingN, setPricingN] = useState("1000");
  const [scenarios, setScenarios] = useState<CodScenarioInput[]>([]);
  const [brackets, setBrackets] = useState<CodBracketInput[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!formula) return;
    const c = formula.config;
    setMode(c.mode);
    setCogsPct(String(c.cogsPct));
    setFRate(String(c.fRate));
    setMRate(String(c.mRate));
    setNItems(String(c.nItems));
    setRMult(String(c.rMult));
    setLLoss(String(c.lLoss));
    setFCost(String(c.fCost));
    setRoundStep(String(c.roundStep));
    setDiscountPct(String(c.discountPct));
    setDiscountTag(c.discountTag);
    setPricingScenario(c.pricingScenario);
    setPricingN(String(c.pricingN));
    setScenarios(JSON.parse(c.scenariosJson));
    setBrackets(JSON.parse(c.bracketsJson));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId, formula?.config.id]);

  function updateScenario(key: string, field: "A" | "d" | "S", value: string) {
    const num = Number(value);
    setScenarios((cur) => cur.map((s) => (s.key === key ? { ...s, [field]: Number.isNaN(num) ? s[field] : num } : s)));
  }

  function updateBracket(i: number, field: "upper" | "rate", value: string) {
    const num = Number(value);
    setBrackets((cur) =>
      cur.map((b, idx) => (idx === i ? { ...b, [field]: Number.isNaN(num) ? b[field] : num } : b))
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api(`/cod-config/${storeId}`, {
        method: "PATCH",
        body: JSON.stringify({
          mode,
          cogsPct: Number(cogsPct),
          fRate: Number(fRate),
          mRate: Number(mRate),
          nItems: Number(nItems),
          rMult: Number(rMult),
          lLoss: Number(lLoss),
          fCost: Number(fCost),
          roundStep: Number(roundStep),
          discountPct: Number(discountPct),
          discountTag: discountTag.trim() || "sale",
          pricingScenario,
          pricingN: Number(pricingN),
          scenarios,
          brackets,
        }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error saving formula");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="page-header" style={{ marginBottom: expanded ? 12 : 0 }}>
        <div>
          <strong>Формула за ценообразуване (COD)</strong>{" "}
          {formula && (
            <span className="muted small">
              k = {fmtK(formula.k)} · средна себестойност {fmtMoney(formula.avgCost || null, currency)} · режим {MODE_LABELS[formula.config.mode]}
              {formula.config.mode !== "cost" && ` · база ${SCENARIO_KEY_LABELS[formula.scenario] ?? formula.scenario}`}
            </span>
          )}
          {formula?.reason && <div className="error-text small">{formula.reason}</div>}
        </div>
        <button type="button" className="small-btn secondary" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Скрий настройките" : "Настройки на формулата"}
        </button>
      </div>

      {expanded && (
        <form className="form" onSubmit={handleSubmit}>
          <div className="form-row">
            <label>
              Режим
              <select value={mode} onChange={(e) => setMode(e.target.value as CodFormulaMode)}>
                <option value="cost">Себестойност (k = 1/cogs_pct)</option>
                <option value="target">Целева печалба</option>
                <option value="breakeven">Break-even</option>
              </select>
            </label>
            {mode === "cost" ? (
              <label>
                Себестойност като % от цената
                <input type="number" step="1" value={cogsPct} onChange={(e) => setCogsPct(e.target.value)} />
              </label>
            ) : (
              <label>
                База за формулата (сценарий)
                <select value={pricingScenario} onChange={(e) => setPricingScenario(e.target.value)}>
                  <option value="pess">Песимистичен</option>
                  <option value="avg">Среден</option>
                  <option value="opt">Оптимистичен</option>
                </select>
              </label>
            )}
          </div>

          {mode !== "cost" && (
            <div className="form-row">
              <label>
                Ефективна ставка на агенцията, f (%)
                <input type="number" step="0.5" value={fRate} onChange={(e) => setFRate(e.target.value)} />
              </label>
              <label>
                Целева нетна печалба, m (%) {mode === "breakeven" && <span className="muted small">(игнорира се — 0 при break-even)</span>}
                <input type="number" step="0.5" value={mRate} onChange={(e) => setMRate(e.target.value)} disabled={mode === "breakeven"} />
              </label>
              <label>
                N за формулата (F/N)
                <input type="number" step="50" value={pricingN} onChange={(e) => setPricingN(e.target.value)} />
              </label>
            </div>
          )}

          <div className="form-row">
            <label>
              Артикули / поръчка (n)
              <input type="number" step="0.1" value={nItems} onChange={(e) => setNItems(e.target.value)} />
            </label>
            <label>
              Кратност при неуспешна пратка (r)
              <input type="number" step="0.5" value={rMult} onChange={(e) => setRMult(e.target.value)} />
            </label>
            <label>
              Загуба на върнати стоки, L (%)
              <input type="number" step="1" value={lLoss} onChange={(e) => setLLoss(e.target.value)} />
            </label>
          </div>

          <div className="form-row">
            <label>
              Други разходи / месец, F ({currency})
              <input type="number" step="100" value={fCost} onChange={(e) => setFCost(e.target.value)} />
            </label>
            <label>
              Стъпка на закръгляне
              <input type="number" step="0.5" value={roundStep} onChange={(e) => setRoundStep(e.target.value)} />
            </label>
            <label>
              Намаление за зачеркнатата цена (%)
              <input type="number" step="1" value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} />
            </label>
            <label>
              Таг за "намален" продукт
              <input value={discountTag} onChange={(e) => setDiscountTag(e.target.value)} placeholder="sale" />
            </label>
          </div>

          {mode !== "cost" && (
            <div>
              <p className="muted small" style={{ margin: "8px 0 4px" }}>
                Сценарии (A = реклама/поръчка, d = delivery success rate %, S = доставка)
              </p>
              {scenarios.map((s) => (
                <div className="form-row" key={s.key}>
                  <label>
                    {SCENARIO_KEY_LABELS[s.key] ?? s.label} — A
                    <input type="number" step="0.5" value={s.A} onChange={(e) => updateScenario(s.key, "A", e.target.value)} />
                  </label>
                  <label>
                    d (%)
                    <input type="number" step="0.5" value={s.d} onChange={(e) => updateScenario(s.key, "d", e.target.value)} />
                  </label>
                  <label>
                    S
                    <input type="number" step="0.5" value={s.S} onChange={(e) => updateScenario(s.key, "S", e.target.value)} />
                  </label>
                </div>
              ))}
            </div>
          )}

          {mode !== "cost" && (
            <div>
              <p className="muted small" style={{ margin: "8px 0 4px" }}>
                Агентска такса — прогресивна, по прагове на оборота
              </p>
              <div className="form-row">
                {brackets.map((b, i) => (
                  <label key={i}>
                    {i === 0 ? "над 0" : `над ${brackets[i - 1].upper ?? "∞"}`} до {b.upper ?? "∞"} — ставка (%)
                    <input type="number" step="0.5" value={b.rate} onChange={(e) => updateBracket(i, "rate", e.target.value)} />
                  </label>
                ))}
              </div>
              <div className="form-row">
                {brackets
                  .map((b, i) => ({ b, i }))
                  .filter(({ b }) => b.upper !== null)
                  .map(({ b, i }) => (
                    <label key={i}>
                      праг #{i + 1} ({currency})
                      <input type="number" step="1000" value={b.upper ?? ""} onChange={(e) => updateBracket(i, "upper", e.target.value)} />
                    </label>
                  ))}
              </div>
            </div>
          )}

          {error && <div className="error-text">{error}</div>}
          <div className="form-row">
            <button type="submit" disabled={saving}>
              {saving ? "Запазване…" : "Запази формулата"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
