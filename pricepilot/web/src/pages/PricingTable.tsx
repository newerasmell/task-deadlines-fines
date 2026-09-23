import { Fragment, useEffect, useMemo, useState } from "react";
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
import { useT } from "../i18n/I18nContext";

const FLAG_LABELS: Record<RowFlag, string> = {
  "above-market": "Над пазара",
  competitive: "Конкурентна",
  "below-market": "Под пазара",
  "below-floor": "Под минимума",
  "no-data": "Няма данни",
};

type SortKey = "title" | "ourPrice" | "minComp" | "deltaPct" | "suggested" | "matchedSourceCount" | "activatedAt";
type RowStatus = { state: "idle" } | { state: "pending" } | { state: "success" } | { state: "error"; message: string };

function fmtMoney(v: number | null, currency: string): string {
  if (v == null) return "—";
  return `${v.toFixed(2)} ${currency}`;
}

// A group's variants very often share the same cost/recommended/compare-at
// (the same physical product, just different sizes) — collapsing to one
// value instead of a range whenever every row actually agrees, rather than
// always showing "X – X", is what makes those fields worth putting on the
// group's own summary row at all.
function summarizeNumbers(values: (number | null)[]): { allSame: boolean; min: number | null; max: number | null } {
  const nonNull = values.filter((v): v is number => v != null);
  if (nonNull.length === 0) return { allSame: true, min: null, max: null };
  const min = Math.min(...nonNull);
  const max = Math.max(...nonNull);
  return { allSame: min === max && nonNull.length === values.length, min, max };
}

function fmtMoneyRange(values: (number | null)[], currency: string): string {
  const { allSame, min, max } = summarizeNumbers(values);
  if (min == null) return "—";
  return allSame ? fmtMoney(min, currency) : `${fmtMoney(min, currency)} – ${fmtMoney(max, currency)}`;
}

function fmtPctRange(values: (number | null)[]): string {
  const { allSame, min, max } = summarizeNumbers(values);
  if (min == null || max == null) return "—";
  const fmt = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
  return allSame ? fmt(min) : `${fmt(min)} – ${fmt(max)}`;
}

function fmtNumberRange(values: (number | null)[]): string {
  const { allSame, min, max } = summarizeNumbers(values);
  if (min == null || max == null) return "—";
  return allSame ? String(min) : `${min} – ${max}`;
}

// activatedAt (ISO strings) has no natural "range" the way a price does —
// shown only when every variant actually shares the exact same instant
// (the normal case, one sync stamping the whole product at once).
function fmtActivatedAtIfUniform(values: (string | null)[]): string {
  const first = values[0];
  return values.every((v) => v === first) ? fmtActivatedAt(first) : "—";
}

function fmtFreshness(iso: string, t: (text: string, params?: Record<string, string | number>) => string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(ms / (1000 * 60 * 60));
  if (hours < 1) return t("току-що");
  if (hours < 24) return t("преди {h}ч", { h: hours });
  return t("преди {d}д", { d: Math.floor(hours / 24) });
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
  const t = useT();
  return (
    <div className="price-compare">
      <div className="price-compare-current">
        <span className="field-label">{t("Нашата цена")}</span>
        <span className="price-compare-value">{fmtMoney(row.ourPrice, currency)}</span>
      </div>
      <span className="price-compare-arrow">→</span>
      <div className={`price-compare-suggested flag-${row.flag}`}>
        <span className="field-label">{isCod ? t("Препоръчана") : t("Предложена")}</span>
        <input
          className="suggested-input-big"
          type="number"
          step="0.01"
          value={suggestedValue ?? ""}
          onChange={(e) => onSuggestedChange(e.target.value)}
          placeholder="—"
        />
        <span className={`badge flag-${row.flag}`}>{t(FLAG_LABELS[row.flag])}</span>
        {row.saleDiscountApplied && (
          <span className="price-compare-note">
            {t("SALE -{pct}% от {price}", { pct: row.saleDiscountPct?.toFixed(0) ?? "", price: fmtMoney(row.salePreDiscountPrice ?? null, currency) })}
          </span>
        )}
      </div>
    </div>
  );
}

export function PricingTable() {
  const { currentStore } = useStores();
  const t = useT();
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
  const [saleOnly, setSaleOnly] = useState(false);

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

  // Variant grouping (table view) — several rows sharing a shopifyProductId
  // (a product's size/color variants, already priced together — see
  // varyPriceForSharedCost in pricing.ts) collapse into one summary row
  // until expanded, instead of listing every size as its own full row by
  // default. Keyed by shopifyProductId, not productId, since that's what
  // ties the rows together.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [groupBulkValue, setGroupBulkValue] = useState<Map<string, string>>(new Map());

  async function refresh() {
    if (!currentStore) return;
    setError(null);
    try {
      const res = await api<PricingTableResponse>(`/pricing/${currentStore.id}`);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Неуспешно зареждане на таблицата с цени");
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
    if (saleOnly) rows = rows.filter((r) => r.saleDiscountApplied);

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
  }, [data, flagFilter, vendorFilter, categoryFilter, search, minDeltaPct, coverageFilter, markdownOnly, saleOnly, sortKey, sortDir]);

  // Groups filteredSortedRows by shopifyProductId, keeping each group at the
  // position of the first row of it the current sort/filter produced — a
  // group with only one row (the common case) renders exactly like before,
  // untouched. Sorting the table itself still operates per row (Δ%, price…
  // don't have one obvious "group" value), so a size run can arrive
  // scrambled; re-sorted by size/variant label within its own group only,
  // where it reads naturally.
  const groupedRows = useMemo(() => {
    const order: string[] = [];
    const byKey = new Map<string, PricingRow[]>();
    for (const row of filteredSortedRows) {
      const key = row.shopifyProductId;
      const list = byKey.get(key);
      if (list) list.push(row);
      else {
        byKey.set(key, [row]);
        order.push(key);
      }
    }
    return order.map((key) => {
      const rows = byKey.get(key)!;
      if (rows.length > 1) {
        // Shopify's own configured order (S, M, L, XL…) — an alphabetical
        // sort on the label puts "L" before "M" before "S" and only
        // happens to work for numeric sizes; variantPosition is exactly
        // what Shopify's own admin already orders variants by.
        rows.sort((a, b) => {
          if (a.variantPosition != null && b.variantPosition != null) return a.variantPosition - b.variantPosition;
          return (a.variantTitle ?? "").localeCompare(b.variantTitle ?? "", undefined, { numeric: true });
        });
      }
      return { key, rows };
    });
  }, [filteredSortedRows]);

  function toggleGroupExpand(key: string) {
    setExpandedGroups((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleGroupSelection(rows: PricingRow[]) {
    const allSelected = rows.every((r) => selected.has(r.productId));
    setSelected((cur) => {
      const next = new Set(cur);
      for (const r of rows) {
        if (allSelected) next.delete(r.productId);
        else next.add(r.productId);
      }
      return next;
    });
  }

  function applyGroupBulk(key: string, rows: PricingRow[]) {
    const raw = groupBulkValue.get(key);
    if (!raw || !raw.trim()) return;
    for (const r of rows) setSuggestedValue(r.productId, raw);
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
          next.set(r.productId, r.status === "SUCCESS" ? { state: "success" } : { state: "error", message: r.errorMessage ?? "Неуспешно" });
        }
        return next;
      });
      refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Публикуването е неуспешно";
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
    if (
      !skipSingleConfirm &&
      !window.confirm(t('Публикувай {price} {currency} за "{title}"?', { price: price.toFixed(2), currency: currentStore?.currency ?? "", title: row.title }))
    )
      return;
    doPublish([{ productId: row.productId, newPrice: price, newCompareAtPrice: row.recommendedComparePrice }], "single");
  }

  async function publishSelected() {
    const items = filteredSortedRows
      .filter((r) => selected.has(r.productId))
      .map((r) => ({ productId: r.productId, newPrice: suggestedFor(r), newCompareAtPrice: r.recommendedComparePrice }))
      .filter((i): i is { productId: string; newPrice: number; newCompareAtPrice: number | null } => i.newPrice != null);
    if (items.length === 0) return;
    const total = items.reduce((s, i) => s + i.newPrice, 0);
    if (
      !window.confirm(
        t("Публикувай {count} избрани продукта (обща сума {total} {currency})?", {
          count: items.length,
          total: total.toFixed(2),
          currency: currentStore?.currency ?? "",
        })
      )
    )
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
      setManualError("Въведи валидна цена");
      return;
    }
    if (!manualUrl.trim()) {
      setManualError("Въведи линк към обявата");
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
      setManualError(err instanceof Error ? err.message : "Неуспешно запазване");
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
        <p className="muted">{t("Все още няма избран магазин — добави от Настройки.")}</p>
      </div>
    );
  }
  if (loading) return <p className="center-loading">{t("Зареждане…")}</p>;
  if (error) return <p className="error-text">{t(error)}</p>;
  if (!data) return null;

  const isCod = currentStore.pricingProfile === "cod_formula";
  const allVisibleSelected = filteredSortedRows.length > 0 && filteredSortedRows.every((r) => selected.has(r.productId));

  // Relative column widths for the table view, turned into percentages
  // that always sum to exactly 100 (see tableColPercents below). Plain
  // width:100% + CSS's default auto table layout hands any leftover
  // width to whichever column has the widest content, which on a large
  // real catalog (thousands of rows, so the widest cell in a column can
  // be almost anything) produced huge, unpredictable gaps between
  // columns. table-layout:fixed ignores content for sizing and only
  // looks at these ratios, so every column gets a consistent, sensible
  // share of the table's width — filling the full page width on a wide
  // screen instead of sitting at a fixed size with dead space after it,
  // but never letting one column swallow the difference either.
  const tableColWeights = [
    3, // checkbox
    22, // product
    19, // price (our price -> suggested)
    8, // compare-at
    9, // active от
    ...(isCod ? [7] : []), // cost
    ...data.sources.map(() => 11), // one per source
    ...(!isCod ? [7] : []), // min
    8, // Δ%
    ...(isCod ? [10] : []), // recommended compare-at
    7, // status
    9, // actions
  ];
  const tableColWeightSum = tableColWeights.reduce((a, b) => a + b, 0);
  const tableColPercents = tableColWeights.map((w) => (w / tableColWeightSum) * 100);
  const totalCols = tableColWeights.length;

  // Shared between the table and card layouts below so the two views can
  // never quietly drift apart on what a cell/field actually shows.
  // `insideGroup`: this row is one variant inside an expanded group whose
  // header already shows the shared product title/image right above it —
  // repeating that per variant just adds noise, so the variant's own
  // label (size, color…) stands in for it instead.
  function renderProductHead(row: PricingRow, insideGroup = false) {
    if (insideGroup) {
      return (
        <div className="group-variant-head">
          <span className="group-variant-label">{row.variantTitle ?? "—"}</span>
        </div>
      );
    }
    return (
      <>
        {row.imageUrl ? <img src={row.imageUrl} className="product-thumb" alt="" /> : <div className="product-thumb" />}
        <div>
          <div className="product-title">
            {row.title}
            {!isCod && row.priority && (
              <span className="tag" title={t("Винаги се сканира при всяко изпълнение")}>
                ★
              </span>
            )}
            {isCod && row.saleDiscountApplied && (
              <span
                className="tag tag-sale"
                title={t('Маркиран с таг "{tag}" в Shopify — доп. {pct}% от {price}', {
                  tag: data!.formula?.config.discountTag ?? "",
                  pct: row.saleDiscountPct?.toFixed(0) ?? "",
                  price: fmtMoney(row.salePreDiscountPrice ?? null, currentStore!.currency),
                })}
              >
                SALE -{row.saleDiscountPct?.toFixed(0)}%
              </span>
            )}
            {isCod && row.discountTagged && !row.saleDiscountApplied && (
              <span className="tag" title={t('Маркиран с таг "{tag}" в Shopify', { tag: data!.formula?.config.discountTag ?? "" })}>
                {t("намален")}
              </span>
            )}
            {isCod && row.markdownEligible && (
              <span className="tag" title={t('{days} дни от "active" — цена над таван, готов за намаляване', { days: row.daysSinceActive ?? "" })}>
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
        title={t("Себестойност (покупна цена) — Cost.csv импорт или ръчно тук")}
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
            placeholder={t("Цена ({currency})", { currency: currentStore!.currency })}
            value={manualPrice}
            onChange={(e) => setManualPrice(e.target.value)}
            autoFocus
          />
          <input type="text" placeholder={t("Линк към обявата")} value={manualUrl} onChange={(e) => setManualUrl(e.target.value)} />
          {manualError && <div className="small row-status-error">{t(manualError)}</div>}
          <div className="manual-entry-actions">
            <button className="small-btn" onClick={() => saveManualEntry(row.productId, s.id)} disabled={manualSaving}>
              {t("Запази")}
            </button>
            <button className="small-btn secondary" onClick={() => setManualEntryOpen(null)} disabled={manualSaving}>
              {t("Отказ")}
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
              {fmtFreshness(cell.fetchedAt, t)} {cell.stale && "⚠️"}
            </div>
          </a>
          {cell.isManual && (
            <div className="manual-badge-row">
              <span className="badge manual-badge" title={t("Въведено ръчно, не от автоматичен източник")}>
                {t("Ръчно")}
              </span>
              <button
                className="edit-manual-btn"
                onClick={() => openManualEntry(row.productId, s.id, { price: cell.price, url: cell.url })}
                title={t("Редактирай ръчния запис")}
              >
                ✎
              </button>
            </div>
          )}
        </>
      );
    }
    return (
      <button className="add-manually-btn" onClick={() => openManualEntry(row.productId, s.id)} title={t("Добави цена от {label} ръчно", { label: s.label })}>
        {t("+ Добави")}
      </button>
    );
  }

  function renderActions(row: PricingRow, status: RowStatus, suggestedValue: number | null) {
    return (
      <>
        <button className="small-btn" onClick={() => publishSingle(row)} disabled={suggestedValue == null || status.state === "pending"}>
          {t("Публикувай")}
        </button>
        {!isCod && (
          <button className="small-btn secondary" onClick={() => togglePriority(row)}>
            {row.priority ? t("Премахни приоритет") : t("Маркирай приоритет")}
          </button>
        )}
      </>
    );
  }

  // The one row shape used both for an ungrouped (single-variant) product
  // and for each variant inside an expanded group — `insideGroup` only
  // changes the Product cell (size/variant label instead of repeating the
  // shared title+image already shown on the group's header row above it)
  // and a light tint + left rule to read as "belonging to" that header.
  // Selection, editing, publish — everything else is the exact same row a
  // group never existed, so nothing about how a row actually works changes
  // depending on whether its product happens to have other variants.
  function renderVariantRow(row: PricingRow, insideGroup = false) {
    const status = rowStatus.get(row.productId) ?? { state: "idle" as const };
    const suggestedValue = suggestedFor(row);
    return (
      <tr key={row.productId} className={insideGroup ? "group-variant-row" : undefined}>
        <td>
          <input type="checkbox" checked={selected.has(row.productId)} onChange={() => toggleRow(row.productId)} />
        </td>
        <td>
          <div className="table-product-cell">{renderProductHead(row, insideGroup)}</div>
        </td>
        <td>
          <PriceCompare
            row={row}
            currency={currentStore!.currency}
            isCod={isCod}
            suggestedValue={suggestedValue}
            onSuggestedChange={(v) => setSuggestedValue(row.productId, v)}
          />
        </td>
        <td>{fmtMoney(row.compareAtPrice, currentStore!.currency)}</td>
        <td className="small">{fmtActivatedAt(row.activatedAt)}</td>
        {isCod && <td>{renderCostInput(row)}</td>}
        {data!.sources.map((s) => (
          <td key={s.id} className={`source-cell${row.sourcePrices[s.id]?.stale ? " stale" : ""}`}>
            {renderSourceCell(row, s)}
          </td>
        ))}
        {!isCod && <td>{fmtMoney(row.minComp, currentStore!.currency)}</td>}
        <td>{row.deltaPct != null ? `${row.deltaPct > 0 ? "+" : ""}${row.deltaPct.toFixed(1)}%` : "—"}</td>
        {isCod && (
          <td title={row.recommendedComparePrice == null ? row.recommendedComparePriceReason ?? undefined : undefined}>
            {fmtMoney(row.recommendedComparePrice, currentStore!.currency)}
          </td>
        )}
        <td>
          {status.state === "pending" && <span className="row-status-spinner">{t("Публикуване…")}</span>}
          {status.state === "success" && <span className="row-status-success">{t("✓ Публикувано")}</span>}
          {status.state === "error" && (
            <Link to="/publish-log" className="row-status-error" title={t(status.message)}>
              {t("✕ Грешка")}
            </Link>
          )}
        </td>
        <td>
          <div style={{ display: "flex", gap: 6, flexDirection: "column" }}>{renderActions(row, status, suggestedValue)}</div>
        </td>
      </tr>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>
          {t("Ценообразуване")} — {currentStore.name}
        </h1>
      </div>

      {isCod && <CodFormulaPanel storeId={currentStore.id} formula={data.formula} currency={currentStore.currency} onSaved={refresh} />}

      <div className="filters-bar">
        <input placeholder={t("Търсене по име / SKU / EAN")} value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={flagFilter} onChange={(e) => setFlagFilter(e.target.value as RowFlag | "")}>
          <option value="">{t("Всички статуси")}</option>
          {(Object.keys(FLAG_LABELS) as RowFlag[]).map((f) => (
            <option key={f} value={f}>
              {t(FLAG_LABELS[f])}
            </option>
          ))}
        </select>
        <select value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)}>
          <option value="">{t("Всички марки")}</option>
          {vendors.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        {data.categories.length > 0 && (
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="">{t("Всички категории")}</option>
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
          <option value="">{t("Всяко покритие")}</option>
          <option value="3">{t("Съвпадение в 3 източника")}</option>
          <option value="2">{t("Съвпадение в 2 източника")}</option>
          <option value="1">{t("Съвпадение в 1 източник")}</option>
          <option value="0">{t("Съвпадение в 0 източника")}</option>
        </select>
        {isCod && (
          <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={markdownOnly} onChange={(e) => setMarkdownOnly(e.target.checked)} />
            {t("Само за намаляване")}
          </label>
        )}
        {isCod && (
          <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={saleOnly} onChange={(e) => setSaleOnly(e.target.checked)} />
            {t("Само SALE")}
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
          <span>{t("{count} избрани", { count: selected.size })}</span>
          <span className="spacer" />
          <button onClick={publishSelected} disabled={bulkPublishing}>
            {bulkPublishing ? t("Публикуване…") : t("Публикувай {count} избрани", { count: selected.size })}
          </button>
          <button className="secondary" onClick={() => setSelected(new Set())}>
            {t("Изчисти избора")}
          </button>
        </div>
      )}

      <div className="pricing-toolbar">
        <label className="select-all-row">
          <input type="checkbox" checked={allVisibleSelected} onChange={(e) => toggleSelectAll(e.target.checked)} />
          {t("Избери всички ({count})", { count: filteredSortedRows.length })}
        </label>
        <div className="sort-control">
          <span className="muted small">{t("Подреди по")}</span>
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
            <option value="title">{t("Продукт")}</option>
            <option value="ourPrice">{t("Нашата цена")}</option>
            <option value="activatedAt">{t("Активен от")}</option>
            {!isCod && <option value="minComp">{t("Мин.")}</option>}
            <option value="deltaPct">{isCod ? t("Δ% спрямо препоръчана") : t("Δ% спрямо мин.")}</option>
            <option value="suggested">{isCod ? t("Препоръчана") : t("Предложена")}</option>
            {!isCod && <option value="matchedSourceCount">{t("Покритие")}</option>}
          </select>
          <button type="button" className="small-btn secondary" onClick={() => setSortDir((d) => (d === 1 ? -1 : 1))}>
            {sortDir === 1 ? t("↑ Възх.") : t("↓ Низх.")}
          </button>
        </div>
        <div className="view-toggle">
          <button type="button" className={`small-btn${viewMode === "table" ? "" : " secondary"}`} onClick={() => setViewMode("table")}>
            {t("Таблица")}
          </button>
          <button type="button" className={`small-btn${viewMode === "cards" ? "" : " secondary"}`} onClick={() => setViewMode("cards")}>
            {t("Карти")}
          </button>
        </div>
      </div>

      {viewMode === "table" ? (
        <div className="table-wrap">
          <table className="pricing-table pricing-table-compact">
            <colgroup>
              {tableColPercents.map((pct, i) => (
                <col key={i} style={{ width: `${pct}%` }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={allVisibleSelected} onChange={(e) => toggleSelectAll(e.target.checked)} />
                </th>
                <th>{t("Продукт")}</th>
                <th>{t("Цена")}</th>
                <th>{t("Стара цена")}</th>
                <th>{t("Активен от")}</th>
                {isCod && <th>{t("Себестойност")}</th>}
                {data.sources.map((s) => (
                  <th key={s.id}>
                    {s.label}
                    {s.degraded && (
                      <span className="tag" title={t("Влошено качество — виж Настройки")}>
                        !
                      </span>
                    )}
                  </th>
                ))}
                {!isCod && <th>{t("Мин.")}</th>}
                <th>{isCod ? t("Δ% спрямо препоръчана") : t("Δ% спрямо мин.")}</th>
                {isCod && <th>{t("Препоръчана стара цена")}</th>}
                <th>{t("Статус")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {groupedRows.map((group) => {
                if (group.rows.length === 1) return renderVariantRow(group.rows[0]);

                const isExpanded = expandedGroups.has(group.key);
                const groupSelected = group.rows.every((r) => selected.has(r.productId));
                const flags = group.rows.map((r) => r.flag);
                const uniformFlag = flags.every((f) => f === flags[0]) ? flags[0] : null;

                // The bulk input mirrors what a single-row publish already does — send the
                // suggested price together with its recommendedComparePrice — so prefill it
                // with that shared value (when every variant agrees) instead of leaving it
                // blank until the user retypes a number the system already computed.
                const suggestedSummary = summarizeNumbers(group.rows.map((r) => suggestedFor(r)));
                const prefillSuggested = suggestedSummary.allSame ? suggestedSummary.min : null;
                const currentCompareAtSummary = summarizeNumbers(group.rows.map((r) => r.compareAtPrice));
                const recommendedCompareAtSummary = summarizeNumbers(group.rows.map((r) => r.recommendedComparePrice));
                const compareAtWillChange =
                  isCod &&
                  recommendedCompareAtSummary.allSame &&
                  recommendedCompareAtSummary.min != null &&
                  (!currentCompareAtSummary.allSame || currentCompareAtSummary.min !== recommendedCompareAtSummary.min);

                return (
                  <Fragment key={group.key}>
                    <tr className="group-header-row">
                      <td>
                        <input
                          type="checkbox"
                          checked={groupSelected}
                          onChange={() => toggleGroupSelection(group.rows)}
                          aria-label={t("Избери всички варианти")}
                        />
                      </td>
                      <td>
                        <div className="table-product-cell group-row-head">
                          <button
                            type="button"
                            className="group-expand-btn"
                            onClick={() => toggleGroupExpand(group.key)}
                            aria-expanded={isExpanded}
                            aria-label={isExpanded ? t("Свий вариантите") : t("Разгъни вариантите")}
                          >
                            <span className="group-expand-chevron" style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}>
                              ▸
                            </span>
                          </button>
                          {renderProductHead(group.rows[0])}
                          <span className="group-row-count">{t("{count} варианта", { count: group.rows.length })}</span>
                        </div>
                      </td>
                      <td>
                        <div className="price-compare">
                          <div className="price-compare-current">
                            <span className="field-label">{t("Нашата цена")}</span>
                            <span className="price-compare-value">
                              {fmtMoneyRange(
                                group.rows.map((r) => r.ourPrice),
                                currentStore!.currency
                              )}
                            </span>
                          </div>
                          <span className="price-compare-arrow">→</span>
                          <div className={`price-compare-suggested flag-${uniformFlag ?? "no-data"}`}>
                            <span className="field-label">
                              {isCod ? t("Препоръчана") : t("Предложена")} — {group.rows.length}x
                            </span>
                            <input
                              className="suggested-input-big"
                              type="number"
                              step="0.01"
                              value={groupBulkValue.get(group.key) ?? (prefillSuggested != null ? String(prefillSuggested) : "")}
                              onChange={(e) => setGroupBulkValue((cur) => new Map(cur).set(group.key, e.target.value))}
                              onBlur={() => applyGroupBulk(group.key, group.rows)}
                              placeholder="—"
                            />
                            <span className={`badge flag-${uniformFlag ?? "no-data"}`}>
                              {uniformFlag ? t(FLAG_LABELS[uniformFlag]) : t("Смесено")}
                            </span>
                            {compareAtWillChange && (
                              <span className="price-compare-note">
                                {t("Стара цена → {price}", { price: fmtMoney(recommendedCompareAtSummary.min, currentStore!.currency) })}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>
                        {fmtMoneyRange(
                          group.rows.map((r) => r.compareAtPrice),
                          currentStore!.currency
                        )}
                      </td>
                      <td className="small">{fmtActivatedAtIfUniform(group.rows.map((r) => r.activatedAt))}</td>
                      {isCod && <td>{fmtNumberRange(group.rows.map((r) => r.cost))}</td>}
                      {data!.sources.map((s) => (
                        <td key={s.id} className="muted small">
                          —
                        </td>
                      ))}
                      {!isCod && (
                        <td>
                          {fmtMoneyRange(
                            group.rows.map((r) => r.minComp),
                            currentStore!.currency
                          )}
                        </td>
                      )}
                      <td>{fmtPctRange(group.rows.map((r) => r.deltaPct))}</td>
                      {isCod && (
                        <td>
                          {fmtMoneyRange(
                            group.rows.map((r) => r.recommendedComparePrice),
                            currentStore!.currency
                          )}
                        </td>
                      )}
                      <td></td>
                      <td></td>
                    </tr>
                    {isExpanded && group.rows.map((row) => renderVariantRow(row, true))}
                  </Fragment>
                );
              })}
              {filteredSortedRows.length === 0 && (
                <tr>
                  <td colSpan={totalCols} className="muted" style={{ textAlign: "center", padding: 30 }}>
                    {t("Няма продукти, отговарящи на тези филтри.")}
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
                    <span className="field-label">{t("Стара цена")}</span>
                    <span className="field-value">{fmtMoney(row.compareAtPrice, currentStore.currency)}</span>
                  </div>
                  <div className="field">
                    <span className="field-label">{t("Активен от")}</span>
                    <span className="field-value small">{fmtActivatedAt(row.activatedAt)}</span>
                  </div>
                  {isCod && (
                    <div className="field">
                      <span className="field-label">{t("Себестойност")}</span>
                      {renderCostInput(row)}
                    </div>
                  )}
                  {!isCod && (
                    <div className="field">
                      <span className="field-label">{t("Мин.")}</span>
                      <span className="field-value">{fmtMoney(row.minComp, currentStore.currency)}</span>
                    </div>
                  )}
                  <div className="field">
                    <span className="field-label">{isCod ? t("Δ% спрямо препоръчана") : t("Δ% спрямо мин.")}</span>
                    <span className="field-value">{row.deltaPct != null ? `${row.deltaPct > 0 ? "+" : ""}${row.deltaPct.toFixed(1)}%` : "—"}</span>
                  </div>
                  {isCod && (
                    <div className="field" title={row.recommendedComparePrice == null ? row.recommendedComparePriceReason ?? undefined : undefined}>
                      <span className="field-label">{t("Препоръчана стара цена")}</span>
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
                          {s.degraded && (
                            <span className="tag" title={t("Влошено качество — виж Настройки")}>
                              !
                            </span>
                          )}
                        </span>
                        {renderSourceCell(row, s)}
                      </div>
                    ))}
                  </div>
                )}

                <div className="pricing-card-footer">
                  <div>
                    {status.state === "pending" && <span className="row-status-spinner">{t("Публикуване…")}</span>}
                    {status.state === "success" && <span className="row-status-success">{t("✓ Публикувано")}</span>}
                    {status.state === "error" && (
                      <Link to="/publish-log" className="row-status-error" title={t(status.message)}>
                        {t("✕ Грешка")}
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
              {t("Няма продукти, отговарящи на тези филтри.")}
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
  const t = useT();
  return (
    <div className="card publish-settings" style={{ marginBottom: 14 }}>
      <div className="publish-settings-title">{t("Настройки за публикуване")}</div>
      <div className="publish-settings-rows">
        {!isCod && (
          <label className="publish-setting-row">
            <input type="checkbox" checked={setCompareAt} onChange={(e) => onSetCompareAtChange(e.target.checked)} />
            <span>
              <span className="publish-setting-label">{t("Задай старата цена на текущата преди публикуване")}</span>
              <span className="publish-setting-desc">
                {t(
                  "Важи за всяка публикация по-долу (единичен ред или групово), докато тази отметка е включена. Изключено по подразбиране — на живо се потвърди, че може да остави старата цена по-ниска от новата, ако я вдигаш, което заменя реалната референтна цена, която е била там преди."
                )}
              </span>
            </span>
          </label>
        )}
        <label className="publish-setting-row">
          <input type="checkbox" checked={skipSingleConfirm} onChange={(e) => onSkipSingleConfirmChange(e.target.checked)} />
          <span>
            <span className="publish-setting-label">{t("Пропусни изскачащото потвърждение")}</span>
            <span className="publish-setting-desc">
              {t(
                'Само за собствения бутон "Публикувай" на единичен ред — публикуването на няколко избрани реда наведнъж винаги пита първо, независимо от това. Запомня се само на това устройство/браузър.'
              )}
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
  const [saleDiscountMinPct, setSaleDiscountMinPct] = useState("30");
  const [saleDiscountMaxPct, setSaleDiscountMaxPct] = useState("35");
  const [pricingScenario, setPricingScenario] = useState("avg");
  const [pricingN, setPricingN] = useState("1000");
  const [scenarios, setScenarios] = useState<CodScenarioInput[]>([]);
  const [brackets, setBrackets] = useState<CodBracketInput[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

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
    setSaleDiscountMinPct(String(c.saleDiscountMinPct));
    setSaleDiscountMaxPct(String(c.saleDiscountMaxPct));
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
    if (Number(saleDiscountMinPct) > Number(saleDiscountMaxPct)) {
      setError("SALE отстъпка: минимумът не може да е по-голям от максимума.");
      return;
    }
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
          saleDiscountMinPct: Number(saleDiscountMinPct),
          saleDiscountMaxPct: Number(saleDiscountMaxPct),
          pricingScenario,
          pricingN: Number(pricingN),
          scenarios,
          brackets,
        }),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Грешка при запазване на формулата");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="page-header" style={{ marginBottom: expanded ? 12 : 0 }}>
        <div>
          <strong>{t("Формула за ценообразуване (COD)")}</strong>{" "}
          {formula && (
            <span className="muted small">
              k = {fmtK(formula.k)} · {t("средна себестойност")} {fmtMoney(formula.avgCost || null, currency)} · {t("режим")}{" "}
              {t(MODE_LABELS[formula.config.mode])}
              {formula.config.mode !== "cost" && ` · ${t("база")} ${t(SCENARIO_KEY_LABELS[formula.scenario] ?? formula.scenario)}`}
            </span>
          )}
          {formula?.reason && <div className="error-text small">{t(formula.reason)}</div>}
        </div>
        <button type="button" className="small-btn secondary" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t("Скрий настройките") : t("Настройки на формулата")}
        </button>
      </div>

      {expanded && (
        <form className="form" onSubmit={handleSubmit}>
          <div className="form-row">
            <label>
              {t("Режим")}
              <select value={mode} onChange={(e) => setMode(e.target.value as CodFormulaMode)}>
                <option value="cost">{t("Себестойност (k = 1/cogs_pct)")}</option>
                <option value="target">{t("Целева печалба")}</option>
                <option value="breakeven">Break-even</option>
              </select>
            </label>
            {mode === "cost" ? (
              <label>
                {t("Себестойност като % от цената")}
                <input type="number" step="1" value={cogsPct} onChange={(e) => setCogsPct(e.target.value)} />
              </label>
            ) : (
              <label>
                {t("База за формулата (сценарий)")}
                <select value={pricingScenario} onChange={(e) => setPricingScenario(e.target.value)}>
                  <option value="pess">{t("Песимистичен")}</option>
                  <option value="avg">{t("Среден")}</option>
                  <option value="opt">{t("Оптимистичен")}</option>
                </select>
              </label>
            )}
          </div>

          {mode !== "cost" && (
            <div className="form-row">
              <label>
                {t("Ефективна ставка на агенцията, f (%)")}
                <input type="number" step="0.5" value={fRate} onChange={(e) => setFRate(e.target.value)} />
              </label>
              <label>
                {t("Целева нетна печалба, m (%)")} {mode === "breakeven" && <span className="muted small">{t("(игнорира се — 0 при break-even)")}</span>}
                <input type="number" step="0.5" value={mRate} onChange={(e) => setMRate(e.target.value)} disabled={mode === "breakeven"} />
              </label>
              <label>
                {t("N за формулата (F/N)")}
                <input type="number" step="50" value={pricingN} onChange={(e) => setPricingN(e.target.value)} />
              </label>
            </div>
          )}

          <div className="form-row">
            <label>
              {t("Артикули / поръчка (n)")}
              <input type="number" step="0.1" value={nItems} onChange={(e) => setNItems(e.target.value)} />
            </label>
            <label>
              {t("Кратност при неуспешна пратка (r)")}
              <input type="number" step="0.5" value={rMult} onChange={(e) => setRMult(e.target.value)} />
            </label>
            <label>
              {t("Загуба на върнати стоки, L (%)")}
              <input type="number" step="1" value={lLoss} onChange={(e) => setLLoss(e.target.value)} />
            </label>
          </div>

          <div className="form-row">
            <label>
              {t("Други разходи / месец, F ({currency})", { currency })}
              <input type="number" step="100" value={fCost} onChange={(e) => setFCost(e.target.value)} />
            </label>
            <label>
              {t("Стъпка на закръгляне")}
              <input type="number" step="0.5" value={roundStep} onChange={(e) => setRoundStep(e.target.value)} />
            </label>
            <label>
              {t("Намаление за зачеркнатата цена (%)")}
              <input type="number" step="1" value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} />
            </label>
            <label>
              {t("SALE таг")}
              <input value={discountTag} onChange={(e) => setDiscountTag(e.target.value)} placeholder="c_sale" />
            </label>
            <label>
              {t("SALE отстъпка — мин. %")}
              <input type="number" step="1" min="0" max="95" value={saleDiscountMinPct} onChange={(e) => setSaleDiscountMinPct(e.target.value)} />
            </label>
            <label>
              {t("SALE отстъпка — макс. %")}
              <input type="number" step="1" min="0" max="95" value={saleDiscountMaxPct} onChange={(e) => setSaleDiscountMaxPct(e.target.value)} />
            </label>
          </div>
          <p className="muted small" style={{ margin: "-6px 0 8px" }}>
            {t(
              "SALE-таг-нат продукт взима допълнителна отстъпка между мин. и макс. % от вече изчислената Recommended цена, на база коефициента на марката (по-висок коефициент → по-близо до макс. %)."
            )}
          </p>

          {mode !== "cost" && (
            <div>
              <p className="muted small" style={{ margin: "8px 0 4px" }}>
                {t("Сценарии (A = реклама/поръчка, d = delivery success rate %, S = доставка)")}
              </p>
              {scenarios.map((s) => (
                <div className="form-row" key={s.key}>
                  <label>
                    {t(SCENARIO_KEY_LABELS[s.key] ?? s.label)} — A
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
                {t("Агентска такса — прогресивна, по прагове на оборота")}
              </p>
              <div className="form-row">
                {brackets.map((b, i) => (
                  <label key={i}>
                    {i === 0 ? t("над 0") : t("над {upper}", { upper: brackets[i - 1].upper ?? "∞" })}{" "}
                    {t("до {upper} — ставка (%)", { upper: b.upper ?? "∞" })}
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
                      {t("праг #{n} ({currency})", { n: i + 1, currency })}
                      <input type="number" step="1000" value={b.upper ?? ""} onChange={(e) => updateBracket(i, "upper", e.target.value)} />
                    </label>
                  ))}
              </div>
            </div>
          )}

          {error && <div className="error-text">{t(error)}</div>}
          <div className="form-row">
            <button type="submit" disabled={saving}>
              {saving ? t("Запазване…") : t("Запази формулата")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
