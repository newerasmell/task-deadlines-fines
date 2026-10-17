import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { Campaign, CampaignProductRow, CampaignProductsResponse, PublishResultItem, SetTagResult } from "../api/types";
import { useStores } from "../context/StoreContext";
import { useT } from "../i18n/I18nContext";
import { Money } from "../lib/money";

type StockFilter = "" | "gt5" | "lte5";
type SortKey = "title" | "inventoryQuantity" | "unitsSold20d";

const CAMPAIGN_TYPE_LABELS: Record<string, string> = {
  black_friday: "Black Friday",
  christmas: "Коледна",
  summer: "Лятна",
  custom: "Друга",
};

const STATUS_LABELS: Record<Campaign["status"], string> = {
  ACTIVE: "Активна",
  REVERTED: "Върната",
  CANCELLED: "Отказана",
};

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// Minutes-granularity for a sub-day remainder — a test campaign set to
// expire in a few minutes would otherwise always read "остават 1д" until
// the instant it ends, making the auto-revert timing impossible to judge.
function formatRemaining(ms: number, t: (text: string, params?: Record<string, string | number>) => string): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / (1000 * 60)));
  if (totalMinutes < 60) return t("{m} мин", { m: totalMinutes });
  if (totalMinutes < 60 * 24) return t("{h} ч", { h: Math.ceil(totalMinutes / 60) });
  return t("{d} дни", { d: Math.ceil(totalMinutes / (60 * 24)) });
}

export function Campaigns() {
  const { currentStore } = useStores();
  const t = useT();

  const [products, setProducts] = useState<CampaignProductRow[]>([]);
  const [categories, setCategories] = useState<{ categoryId: string; title: string }[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);

  const [vendorFilter, setVendorFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [stockFilter, setStockFilter] = useState<StockFilter>("");
  const [noSales20dOnly, setNoSales20dOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("title");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [tagInput, setTagInput] = useState("c_marketing");
  const [taggingBusy, setTaggingBusy] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);

  const [campaignName, setCampaignName] = useState("");
  const [campaignType, setCampaignType] = useState("black_friday");
  const [discountPct, setDiscountPct] = useState("20");
  const [durationDays, setDurationDays] = useState("10");
  // Optional override for quick testing (apply → wait a few minutes →
  // confirm the scheduler auto-reverted it) without waiting out a real
  // day-long campaign. Takes over from durationDays whenever it's filled.
  const [testMinutes, setTestMinutes] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applySummary, setApplySummary] = useState<string | null>(null);

  const [revertingId, setRevertingId] = useState<string | null>(null);

  async function refreshProducts() {
    if (!currentStore) return;
    const res = await api<CampaignProductsResponse>(`/campaigns/${currentStore.id}/products`);
    setProducts(res.products);
    setCategories(res.categories);
  }

  async function refreshCampaigns() {
    if (!currentStore) return;
    const res = await api<Campaign[]>(`/campaigns/${currentStore.id}`);
    setCampaigns(res);
  }

  useEffect(() => {
    setLoading(true);
    Promise.all([refreshProducts(), refreshCampaigns()]).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStore?.id]);

  useEffect(() => {
    if (campaignType !== "custom") setCampaignName(CAMPAIGN_TYPE_LABELS[campaignType]);
  }, [campaignType]);

  const categoriesById = useMemo(() => new Map(categories.map((c) => [c.categoryId, c.title])), [categories]);

  const vendors = useMemo(() => Array.from(new Set(products.map((p) => p.vendor).filter((v): v is string => Boolean(v)))).sort(), [products]);
  const tags = useMemo(() => Array.from(new Set(products.flatMap((p) => p.tags))).sort(), [products]);

  const filteredSortedRows = useMemo(() => {
    let rows = products;
    if (vendorFilter) rows = rows.filter((p) => p.vendor === vendorFilter);
    if (categoryFilter) rows = rows.filter((p) => p.categoryIds.includes(categoryFilter));
    if (tagFilter) rows = rows.filter((p) => p.tags.includes(tagFilter));
    if (stockFilter === "gt5") rows = rows.filter((p) => p.inventoryQuantity != null && p.inventoryQuantity > 5);
    if (stockFilter === "lte5") rows = rows.filter((p) => p.inventoryQuantity != null && p.inventoryQuantity <= 5);
    if (noSales20dOnly) rows = rows.filter((p) => p.unitsSold20d === 0);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((p) => p.title.toLowerCase().includes(q) || p.sku?.toLowerCase().includes(q));
    }

    const dir = sortDir;
    return [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return ((av as number) - (bv as number)) * dir;
    });
  }, [products, vendorFilter, categoryFilter, tagFilter, stockFilter, noSales20dOnly, search, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  }

  function toggleRow(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allVisibleSelected = filteredSortedRows.length > 0 && filteredSortedRows.every((p) => selected.has(p.productId));

  function toggleSelectAll(checked: boolean) {
    if (checked) setSelected(new Set(filteredSortedRows.map((p) => p.productId)));
    else setSelected(new Set());
  }

  const selectedRows = products.filter((p) => selected.has(p.productId));

  async function setTagOnSelected(mode: "add" | "remove") {
    if (!currentStore || selected.size === 0 || !tagInput.trim()) return;
    setTaggingBusy(true);
    setTagError(null);
    try {
      const res = await api<{ results: SetTagResult[] }>(`/tags/${mode}`, {
        method: "POST",
        body: JSON.stringify({ storeId: currentStore.id, productIds: [...selected], tag: tagInput.trim() }),
      });
      const failed = res.results.filter((r) => r.status === "ERROR");
      if (failed.length > 0) setTagError(t("{count} продукт(а) с грешка.", { count: failed.length }));
      await refreshProducts();
    } catch (err) {
      setTagError(err instanceof Error ? err.message : t("Неуспешно прилагане на таг."));
    } finally {
      setTaggingBusy(false);
    }
  }

  async function applyCampaign() {
    if (!currentStore || selected.size === 0) return;
    const pct = Number(discountPct);
    const days = Number(durationDays);
    const minutesRaw = testMinutes.trim();
    const usingTestMinutes = minutesRaw !== "";
    const minutes = Number(minutesRaw);
    if (!campaignName.trim() || Number.isNaN(pct) || pct <= 0 || pct >= 100) {
      setApplyError(t("Попълни валидно име и процент (1–99)."));
      return;
    }
    if (usingTestMinutes ? !Number.isInteger(minutes) || minutes <= 0 : !Number.isInteger(days) || days <= 0) {
      setApplyError(
        usingTestMinutes
          ? t("Тестовите минути трябва да са цяло число > 0.")
          : t("Продължителността в дни трябва да е цяло число > 0.")
      );
      return;
    }
    const durationLabel = usingTestMinutes ? t("{m} мин (тест)", { m: minutes }) : t("{d} дни", { d: days });
    if (
      !window.confirm(
        t('Приложи "{name}" (-{pct}% за {duration}) върху {count} продукта?', {
          name: campaignName.trim(),
          pct,
          duration: durationLabel,
          count: selected.size,
        })
      )
    )
      return;
    setApplying(true);
    setApplyError(null);
    setApplySummary(null);
    try {
      const res = await api<{ campaignId: string; results: PublishResultItem[] }>("/campaigns", {
        method: "POST",
        body: JSON.stringify({
          storeId: currentStore.id,
          name: campaignName.trim(),
          campaignType,
          discountPct: pct,
          ...(usingTestMinutes ? { durationMinutes: minutes } : { durationDays: days }),
          productIds: [...selected],
        }),
      });
      const successCount = res.results.filter((r) => r.status === "SUCCESS").length;
      const failCount = res.results.length - successCount;
      setApplySummary(
        failCount > 0
          ? t("Приложено за {ok} продукта, {fail} с грешка.", { ok: successCount, fail: failCount })
          : t("Приложено за {ok} продукта.", { ok: successCount })
      );
      setSelected(new Set());
      await Promise.all([refreshProducts(), refreshCampaigns()]);
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : t("Неуспешно стартиране на кампанията."));
    } finally {
      setApplying(false);
    }
  }

  async function revertCampaign(campaign: Campaign) {
    if (!currentStore || campaign.status !== "ACTIVE") return;
    if (!window.confirm(t('Да върна ли кампания "{name}" преди края на срока й?', { name: campaign.name }))) return;
    setRevertingId(campaign.id);
    try {
      await api(`/campaigns/${campaign.id}/revert`, { method: "POST" });
      await Promise.all([refreshProducts(), refreshCampaigns()]);
    } finally {
      setRevertingId(null);
    }
  }

  if (!currentStore) return <p className="muted">{t("Няма избран магазин.")}</p>;
  if (loading) return <p className="center-loading">{t("Зареждане…")}</p>;

  return (
    <div>
      <div className="page-header">
        <h1>{t("Кампании — {name}", { name: currentStore.name })}</h1>
      </div>

      <div className="filters-bar">
        <input placeholder={t("Търси по заглавие или SKU")} value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)}>
          <option value="">{t("Всички марки")}</option>
          {vendors.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
          <option value="">{t("Всички категории")}</option>
          {categories.map((c) => (
            <option key={c.categoryId} value={c.categoryId}>
              {c.title}
            </option>
          ))}
        </select>
        <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
          <option value="">{t("Всички тагове")}</option>
          {tags.map((tg) => (
            <option key={tg} value={tg}>
              {tg}
            </option>
          ))}
        </select>
        <select value={stockFilter} onChange={(e) => setStockFilter(e.target.value as StockFilter)}>
          <option value="">{t("Наличност — всички")}</option>
          <option value="gt5">{t("Над 5 бр.")}</option>
          <option value="lte5">{t("5 бр. или по-малко")}</option>
        </select>
        <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={noSales20dOnly} onChange={(e) => setNoSales20dOnly(e.target.checked)} />
          {t("Без продажби (20 дни)")}
        </label>
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar">
          <span>{t("Избрани: {count}", { count: selected.size })}</span>
          <div className="spacer" />
          <input style={{ width: 140 }} value={tagInput} onChange={(e) => setTagInput(e.target.value)} placeholder="c_marketing" />
          <button className="secondary" onClick={() => setTagOnSelected("add")} disabled={taggingBusy}>
            {t("Добави таг")}
          </button>
          <button className="secondary" onClick={() => setTagOnSelected("remove")} disabled={taggingBusy}>
            {t("Премахни таг")}
          </button>
          {tagError && <span className="row-status-error small">{tagError}</span>}
        </div>
      )}

      <div className="table-wrap">
        <table className="pricing-table">
          <thead>
            <tr>
              <th>
                <input type="checkbox" checked={allVisibleSelected} onChange={(e) => toggleSelectAll(e.target.checked)} />
              </th>
              <th onClick={() => toggleSort("title")} style={{ cursor: "pointer" }}>
                {t("Продукт")}
              </th>
              <th>{t("Марка")}</th>
              <th>{t("Цена")}</th>
              <th onClick={() => toggleSort("inventoryQuantity")} style={{ cursor: "pointer" }}>
                {t("Наличност")}
              </th>
              <th onClick={() => toggleSort("unitsSold20d")} style={{ cursor: "pointer" }}>
                {t("Продажби (20д)")}
              </th>
              <th>{t("Тагове")}</th>
            </tr>
          </thead>
          <tbody>
            {filteredSortedRows.map((p) => (
              <tr key={p.productId}>
                <td>
                  <input type="checkbox" checked={selected.has(p.productId)} onChange={() => toggleRow(p.productId)} />
                </td>
                <td>
                  {p.title}
                  {p.variantTitle && <span className="muted small"> ({p.variantTitle})</span>}
                  <div className="muted small">{p.categoryIds.map((id) => categoriesById.get(id)).filter(Boolean).join(", ")}</div>
                </td>
                <td>{p.vendor ?? "—"}</td>
                <td>
                  <Money value={p.price} currency={currentStore.currency} eurRate={null} />
                </td>
                <td>{p.inventoryQuantity ?? "—"}</td>
                <td>{p.unitsSold20d ?? t("няма данни")}</td>
                <td className="muted small">{p.tags.join(", ") || "—"}</td>
              </tr>
            ))}
            {filteredSortedRows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ textAlign: "center", padding: 30 }}>
                  {t("Няма продукти, отговарящи на филтрите.")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected.size > 0 && (
        <div className="settings-section">
          <h2>{t("Нова кампания")}</h2>
          <div className="form-row">
            <label>
              {t("Тип")}
              <select value={campaignType} onChange={(e) => setCampaignType(e.target.value)}>
                {Object.entries(CAMPAIGN_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {t(label)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("Име")}
              <input value={campaignName} onChange={(e) => setCampaignName(e.target.value)} />
            </label>
            <label>
              {t("Отстъпка, %")}
              <input type="number" step="1" min="1" max="99" value={discountPct} onChange={(e) => setDiscountPct(e.target.value)} />
            </label>
            <label>
              {t("Продължителност, дни")}
              <input
                type="number"
                step="1"
                min="1"
                value={durationDays}
                onChange={(e) => setDurationDays(e.target.value)}
                disabled={testMinutes.trim() !== ""}
              />
            </label>
            <label>
              {t("или тест: минути")}
              <input
                type="number"
                step="1"
                min="1"
                placeholder={t("незадължително")}
                value={testMinutes}
                onChange={(e) => setTestMinutes(e.target.value)}
              />
            </label>
          </div>
          {testMinutes.trim() !== "" && (
            <p className="muted small" style={{ marginTop: -4 }}>
              {t("Тестов режим — кампанията ще изтече след {m} мин. вместо след зададените дни.", { m: testMinutes.trim() })}
            </p>
          )}

          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="pricing-table">
              <thead>
                <tr>
                  <th>{t("Продукт")}</th>
                  <th>{t("Сегашна цена")}</th>
                  <th>{t("Нова цена")}</th>
                  <th>{t("Ще се вижда като (compare-at)")}</th>
                </tr>
              </thead>
              <tbody>
                {selectedRows.map((p) => {
                  const pct = Number(discountPct);
                  const valid = !Number.isNaN(pct) && pct > 0 && pct < 100;
                  const newPrice = valid ? round2(p.price * (1 - pct / 100)) : null;
                  return (
                    <tr key={p.productId}>
                      <td>{p.title}</td>
                      <td>
                        <Money value={p.price} currency={currentStore.currency} eurRate={null} />
                      </td>
                      <td>{newPrice != null ? <Money value={newPrice} currency={currentStore.currency} eurRate={null} /> : "—"}</td>
                      <td>
                        <Money value={p.compareAtPrice ?? p.price} currency={currentStore.currency} eurRate={null} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {applyError && <p className="row-status-error small">{applyError}</p>}
          {applySummary && <p className="row-status-success small">{applySummary}</p>}
          <button onClick={applyCampaign} disabled={applying} style={{ marginTop: 10 }}>
            {applying ? t("Прилагам…") : t("Приложи")}
          </button>
        </div>
      )}

      <div className="settings-section">
        <h2>{t("Активни кампании")}</h2>
        <div className="entity-list">
          {campaigns.map((c) => {
            const remainingMs = new Date(c.endsAt).getTime() - Date.now();
            return (
              <div key={c.id} className="entity-row" style={c.status !== "ACTIVE" ? { opacity: 0.6 } : undefined}>
                <div>
                  <strong>{c.name}</strong>
                  <span className="muted small">
                    {" · "}
                    {t(CAMPAIGN_TYPE_LABELS[c.campaignType] ?? c.campaignType)}
                    {" · -"}
                    {c.discountPct}% · {c.itemCount} {t("продукта")}
                    {c.status === "ACTIVE" && <> · {t("остават {remaining}", { remaining: formatRemaining(remainingMs, t) })}</>}
                  </span>
                  <div className="muted small">
                    <span className="badge">{t(STATUS_LABELS[c.status])}</span>
                    {c.createdByName && <> · {t("от {name}", { name: c.createdByName })}</>}
                  </div>
                </div>
                <div className="entity-row-actions">
                  {c.status === "ACTIVE" && (
                    <button className="secondary small" onClick={() => revertCampaign(c)} disabled={revertingId === c.id}>
                      {revertingId === c.id ? "…" : t("Върни сега")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {campaigns.length === 0 && <p className="muted">{t("Все още няма кампании.")}</p>}
        </div>
      </div>
    </div>
  );
}
