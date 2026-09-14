import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { PublishLogEntry } from "../api/types";
import { useStores } from "../context/StoreContext";

export function PublishLog() {
  const { currentStore } = useStores();
  const [logs, setLogs] = useState<PublishLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");

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

  if (!currentStore) return <p className="muted">No store selected.</p>;

  return (
    <div>
      <div className="page-header">
        <h1>Publish log — {currentStore.name}</h1>
      </div>

      <div className="filters-bar">
        <input placeholder="Search product title" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="SUCCESS">Success</option>
          <option value="ERROR">Error</option>
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">Single + bulk</option>
          <option value="single">Single</option>
          <option value="bulk">Bulk</option>
        </select>
      </div>

      {loading ? (
        <p className="center-loading">Loading…</p>
      ) : (
        <div className="table-wrap">
          <table className="pricing-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Old price</th>
                <th>New price</th>
                <th>Compare-at</th>
                <th>Status</th>
                <th>Mode</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td>{log.productTitle ?? log.variantId}</td>
                  <td>{log.oldPrice.toFixed(2)}</td>
                  <td>{log.newPrice.toFixed(2)}</td>
                  <td>
                    {log.oldCompareAt != null ? log.oldCompareAt.toFixed(2) : "—"}
                    {log.newCompareAt != null ? ` → ${log.newCompareAt.toFixed(2)}` : ""}
                  </td>
                  <td>
                    {log.status === "SUCCESS" ? (
                      <span className="row-status-success">✓ Success</span>
                    ) : (
                      <span className="row-status-error" title={log.errorMessage ?? undefined}>
                        ✕ {log.errorMessage ?? "Error"}
                      </span>
                    )}
                  </td>
                  <td>{log.source}</td>
                  <td>{new Date(log.createdAt).toLocaleString()}</td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted" style={{ textAlign: "center", padding: 30 }}>
                    No publish activity yet.
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
