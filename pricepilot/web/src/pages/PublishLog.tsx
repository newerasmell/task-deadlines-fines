import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { PublishLogEntry, RevertResultItem } from "../api/types";
import { useStores } from "../context/StoreContext";
import { useT } from "../i18n/I18nContext";

export function PublishLog() {
  const { currentStore } = useStores();
  const t = useT();
  const [logs, setLogs] = useState<PublishLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reverting, setReverting] = useState<Set<string>>(new Set());
  const [revertErrors, setRevertErrors] = useState<Map<string, string>>(new Map());
  const [bulkReverting, setBulkReverting] = useState(false);

  async function refresh() {
    if (!currentStore) return;
    const params = new URLSearchParams({ storeId: currentStore.id });
    if (status) params.set("status", status);
    if (source) params.set("source", source);
    if (search.trim()) params.set("search", search.trim());
    const res = await api<PublishLogEntry[]>(`/publish-log?${params.toString()}`);
    setLogs(res);
    setLoading(false);
  }

  useEffect(() => {
    setLoading(true);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStore?.id, status, source, search]);

  // A log entry is revertible only if it actually succeeded and hasn't
  // already been reverted once — reverting the same entry twice would push
  // the same rollback to Shopify a second time for no reason.
  function canRevert(log: PublishLogEntry): boolean {
    return log.status === "SUCCESS" && !log.revertedAt;
  }

  function applyRevertResults(results: RevertResultItem[]) {
    const errors = new Map(revertErrors);
    for (const r of results) {
      if (r.status === "ERROR") errors.set(r.logId, r.errorMessage ?? t("Грешка при връщане."));
      else errors.delete(r.logId);
    }
    setRevertErrors(errors);
  }

  async function revertOne(log: PublishLogEntry) {
    if (!currentStore || !canRevert(log)) return;
    if (!window.confirm(t('Да върна ли "{name}" към предходните стойности?', { name: log.productTitle ?? log.variantId })))
      return;
    setReverting((cur) => new Set(cur).add(log.id));
    try {
      const res = await api<{ results: RevertResultItem[] }>("/publish/revert", {
        method: "POST",
        body: JSON.stringify({ storeId: currentStore.id, logIds: [log.id] }),
      });
      applyRevertResults(res.results);
      await refresh();
    } finally {
      setReverting((cur) => {
        const next = new Set(cur);
        next.delete(log.id);
        return next;
      });
    }
  }

  async function revertSelected() {
    if (!currentStore || selected.size === 0) return;
    if (!window.confirm(t("Да върна ли {count} избрани публикации към предходните им стойности?", { count: selected.size })))
      return;
    setBulkReverting(true);
    try {
      const res = await api<{ results: RevertResultItem[] }>("/publish/revert", {
        method: "POST",
        body: JSON.stringify({ storeId: currentStore.id, logIds: [...selected] }),
      });
      applyRevertResults(res.results);
      setSelected(new Set());
      await refresh();
    } finally {
      setBulkReverting(false);
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

  const revertibleLogs = logs.filter(canRevert);
  const allRevertibleSelected = revertibleLogs.length > 0 && revertibleLogs.every((l) => selected.has(l.id));

  function toggleSelectAll(checked: boolean) {
    setSelected(checked ? new Set(revertibleLogs.map((l) => l.id)) : new Set());
  }

  if (!currentStore) return <p className="muted">{t("Няма избран магазин.")}</p>;

  return (
    <div>
      <div className="page-header">
        <h1>{t("Дневник публикации — {name}", { name: currentStore.name })}</h1>
        {selected.size > 0 && (
          <button className="secondary" onClick={revertSelected} disabled={bulkReverting}>
            {bulkReverting ? t("Връщам…") : t("Върни избраните ({count})", { count: selected.size })}
          </button>
        )}
      </div>

      <div className="filters-bar">
        <input placeholder={t("Търсене по заглавие на продукт")} value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t("Всички статуси")}</option>
          <option value="SUCCESS">{t("Успешно")}</option>
          <option value="ERROR">{t("Грешка")}</option>
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">{t("Единично + групово + връщане")}</option>
          <option value="single">{t("Единично")}</option>
          <option value="bulk">{t("Групово")}</option>
          <option value="revert">{t("Връщане")}</option>
        </select>
      </div>

      {loading ? (
        <p className="center-loading">{t("Зареждане…")}</p>
      ) : (
        <div className="table-wrap">
          <table className="pricing-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={allRevertibleSelected}
                    onChange={(e) => toggleSelectAll(e.target.checked)}
                    disabled={revertibleLogs.length === 0}
                  />
                </th>
                <th>{t("Продукт")}</th>
                <th>{t("Предишна цена")}</th>
                <th>{t("Нова цена")}</th>
                <th>{t("Стара цена")}</th>
                <th>{t("Статус")}</th>
                <th>{t("Режим")}</th>
                <th>{t("Кога")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const error = revertErrors.get(log.id);
                return (
                  <tr key={log.id}>
                    <td>
                      {canRevert(log) && (
                        <input type="checkbox" checked={selected.has(log.id)} onChange={() => toggleRow(log.id)} />
                      )}
                    </td>
                    <td>{log.productTitle ?? log.variantId}</td>
                    <td>{log.oldPrice.toFixed(2)}</td>
                    <td>{log.newPrice.toFixed(2)}</td>
                    <td>
                      {log.oldCompareAt != null ? log.oldCompareAt.toFixed(2) : "—"}
                      {log.newCompareAt != null ? ` → ${log.newCompareAt.toFixed(2)}` : ""}
                    </td>
                    <td>
                      {log.status === "SUCCESS" ? (
                        <span className="row-status-success">✓ {t("Успешно")}</span>
                      ) : (
                        <span className="row-status-error" title={log.errorMessage ?? undefined}>
                          ✕ {log.errorMessage ?? t("Грешка")}
                        </span>
                      )}
                    </td>
                    <td>
                      {log.source}
                      {log.revertedAt && (
                        <span className="tag" title={t("Върната на {date}", { date: new Date(log.revertedAt).toLocaleString() })}>
                          {t("Върната")}
                        </span>
                      )}
                    </td>
                    <td>{new Date(log.createdAt).toLocaleString()}</td>
                    <td>
                      {canRevert(log) && (
                        <button className="secondary small" onClick={() => revertOne(log)} disabled={reverting.has(log.id)}>
                          {reverting.has(log.id) ? "…" : t("Върни")}
                        </button>
                      )}
                      {error && (
                        <div className="row-status-error small" title={error}>
                          {error}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted" style={{ textAlign: "center", padding: 30 }}>
                    {t("Все още няма публикувани промени.")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
