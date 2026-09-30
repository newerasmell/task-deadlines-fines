import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { CrossStoreDiff, CrossStoreRow, PublishResultItem } from "../api/types";
import { useStores } from "../context/StoreContext";
import { useT } from "../i18n/I18nContext";
import { Money } from "../lib/money";

type RowStatus = { state: "idle" } | { state: "success" } | { state: "error"; message: string };

export function TransferPrices() {
  const { stores } = useStores();
  const t = useT();
  const [sourceStoreId, setSourceStoreId] = useState("");
  const [targetStoreId, setTargetStoreId] = useState("");
  const [diff, setDiff] = useState<CrossStoreDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rowStatus, setRowStatus] = useState<Map<string, RowStatus>>(new Map());
  const [applying, setApplying] = useState(false);

  async function refresh() {
    if (!sourceStoreId || !targetStoreId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api<CrossStoreDiff>(
        `/cross-store-pricing?sourceStoreId=${encodeURIComponent(sourceStoreId)}&targetStoreId=${encodeURIComponent(targetStoreId)}`
      );
      setDiff(res);
      setSelected(new Set());
      setRowStatus(new Map());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Неуспешно зареждане"));
      setDiff(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setDiff(null);
    if (sourceStoreId && targetStoreId && sourceStoreId !== targetStoreId) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceStoreId, targetStoreId]);

  const visibleRows = useMemo(() => {
    if (!diff) return [];
    return onlyChanged ? diff.rows.filter((r) => r.priceChanged) : diff.rows;
  }, [diff, onlyChanged]);

  // A title-mismatch row (SKU/barcode matched, but the names don't look
  // like the same product — likely a mixed-up SKU) never joins "select
  // all" — only an explicit, individual click can include one, after
  // someone's actually looked at the two names.
  const selectableRows = useMemo(() => visibleRows.filter((r) => !r.titleMismatch), [visibleRows]);
  const allVisibleSelected = selectableRows.length > 0 && selectableRows.every((r) => selected.has(r.targetProductId));

  function toggleRow(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll(checked: boolean) {
    setSelected(checked ? new Set(selectableRows.map((r) => r.targetProductId)) : new Set());
  }

  async function applySelected() {
    if (!diff || selected.size === 0) return;
    const targetStore = stores.find((s) => s.id === targetStoreId);
    const items = diff.rows
      .filter((r) => selected.has(r.targetProductId))
      .map((r) => ({
        productId: r.targetProductId,
        newPrice: r.newPrice,
        setCompareAt: false,
        newCompareAtPrice: r.newCompareAtPrice,
      }));
    if (items.length === 0) return;
    if (
      !window.confirm(
        t('Приложи {count} нови цени в "{store}"? Ще се публикуват направо в Shopify.', {
          count: items.length,
          store: targetStore?.name ?? "",
        })
      )
    )
      return;

    setApplying(true);
    setRowStatus((cur) => {
      const next = new Map(cur);
      for (const i of items) next.delete(i.productId);
      return next;
    });
    try {
      const res = await api<{ results: PublishResultItem[] }>("/publish", {
        method: "POST",
        body: JSON.stringify({ storeId: targetStoreId, mode: "bulk", items }),
      });
      setRowStatus((cur) => {
        const next = new Map(cur);
        for (const r of res.results) {
          next.set(r.productId, r.status === "SUCCESS" ? { state: "success" } : { state: "error", message: r.errorMessage ?? t("Грешка") });
        }
        return next;
      });
      setSelected(new Set());
      // Only re-fetch the underlying diff (not the row-status map) so
      // success/error badges stay visible instead of vanishing the instant
      // a freshly-applied row's price no longer differs from the target.
      const res2 = await api<CrossStoreDiff>(
        `/cross-store-pricing?sourceStoreId=${encodeURIComponent(sourceStoreId)}&targetStoreId=${encodeURIComponent(targetStoreId)}`
      );
      setDiff(res2);
    } finally {
      setApplying(false);
    }
  }

  function renderRow(row: CrossStoreRow) {
    const status = rowStatus.get(row.targetProductId) ?? { state: "idle" as const };
    return (
      <tr key={row.targetProductId} className={row.titleMismatch ? "cross-store-mismatch-row" : undefined}>
        <td>
          <input type="checkbox" checked={selected.has(row.targetProductId)} onChange={() => toggleRow(row.targetProductId)} />
        </td>
        <td>
          <div className="table-product-cell">
            {row.imageUrl ? <img src={row.imageUrl} className="product-thumb" alt="" /> : <div className="product-thumb" />}
            <div>
              <div className="product-title">
                {row.title}
                {row.variantTitle && <span className="muted"> — {row.variantTitle}</span>}
              </div>
              <div className="product-sku">{row.sku ?? "—"}</div>
              {row.titleMismatch && (
                <div className="row-status-error small">
                  {t('⚠ В source се казва "{title}" — провери преди да приложиш', { title: row.sourceTitle })}
                </div>
              )}
            </div>
          </div>
        </td>
        <td>
          <span className="badge" title={row.matchedBy === "sku" ? t("Съвпадение по SKU") : t("Съвпадение по баркод")}>
            {row.matchedBy === "sku" ? "SKU" : t("баркод")}
          </span>
        </td>
        <td>
          <Money value={row.targetPrice} currency={diff!.targetCurrency} eurRate={null} />
        </td>
        <td>
          <Money value={row.sourcePrice} currency={diff!.sourceCurrency} eurRate={null} />
        </td>
        <td className={row.priceChanged ? "row-status-success" : undefined}>
          <Money value={row.newPrice} currency={diff!.targetCurrency} eurRate={null} />
        </td>
        <td>{row.deltaPct != null ? `${row.deltaPct > 0 ? "+" : ""}${row.deltaPct.toFixed(1)}%` : "—"}</td>
        <td>
          {status.state === "success" && <span className="row-status-success">✓ {t("Публикувано")}</span>}
          {status.state === "error" && (
            <span className="row-status-error" title={status.message}>
              ✕ {status.message}
            </span>
          )}
        </td>
      </tr>
    );
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t("Прехвърляне на цени между магазини")}</h1>
      </div>
      <p className="muted">
        {t(
          "Избери магазин с оправени цени (source) и магазин, в който да ги приложиш (target) — продуктите се съпоставят по SKU (при липса — по баркод), а новата цена се пресмята автоматично във валутата на target магазина."
        )}
      </p>

      <div className="filters-bar">
        <label>
          {t("От магазин (source)")}
          <select value={sourceStoreId} onChange={(e) => setSourceStoreId(e.target.value)}>
            <option value="">{t("— избери —")}</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id} disabled={s.id === targetStoreId}>
                {s.name} ({s.currency})
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Към магазин (target)")}
          <select value={targetStoreId} onChange={(e) => setTargetStoreId(e.target.value)}>
            <option value="">{t("— избери —")}</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id} disabled={s.id === sourceStoreId}>
                {s.name} ({s.currency})
              </option>
            ))}
          </select>
        </label>
        {diff && (
          <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} />
            {t("Само с разлика в цената")}
          </label>
        )}
      </div>

      {loading && <p className="center-loading">{t("Зареждане…")}</p>}
      {error && <p className="error-text">{error}</p>}

      {diff && !loading && (
        <>
          {diff.conversionUnavailable ? (
            <p className="error-text">
              {t("Не успях да намеря валутен курс {from} → {to} в момента — опитай отново след малко.", {
                from: diff.sourceCurrency,
                to: diff.targetCurrency,
              })}
            </p>
          ) : (
            <>
              <p className="muted small">
                {diff.sourceCurrency !== diff.targetCurrency &&
                  t("Цените се конвертират от {from} в {to}.", { from: diff.sourceCurrency, to: diff.targetCurrency })}{" "}
                {t("{matched} съвпадения ({changed} с различна цена).", {
                  matched: diff.rows.length,
                  changed: diff.rows.filter((r) => r.priceChanged).length,
                })}{" "}
                {diff.unmatchedSourceCount > 0 &&
                  t("{count} продукта от source нямат съвпадение по SKU/баркод в target и не могат да се пренесат.", {
                    count: diff.unmatchedSourceCount,
                  })}{" "}
                {diff.titleMismatchCount > 0 && (
                  <span className="row-status-error">
                    {t("{count} съвпадения са маркирани в червено — имената не изглеждат като един и същ продукт, провери ги.", {
                      count: diff.titleMismatchCount,
                    })}
                  </span>
                )}
              </p>

              {selected.size > 0 && (
                <div className="bulk-bar">
                  <span>{t("{count} избрани", { count: selected.size })}</span>
                  <span className="spacer" />
                  <button onClick={applySelected} disabled={applying}>
                    {applying ? t("Публикуване…") : t("Приложи и публикувай ({count})", { count: selected.size })}
                  </button>
                  <button className="secondary" onClick={() => setSelected(new Set())}>
                    {t("Изчисти избора")}
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
                      <th>{t("Продукт")}</th>
                      <th>{t("Съвпадение")}</th>
                      <th>{t("Текуща цена (target)")}</th>
                      <th>{t("Цена в source")}</th>
                      <th>{t("Нова цена (target)")}</th>
                      <th>Δ%</th>
                      <th>{t("Статус")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map(renderRow)}
                    {visibleRows.length === 0 && (
                      <tr>
                        <td colSpan={8} className="muted" style={{ textAlign: "center", padding: 30 }}>
                          {onlyChanged ? t("Няма продукти с различна цена.") : t("Няма съвпадения.")}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
