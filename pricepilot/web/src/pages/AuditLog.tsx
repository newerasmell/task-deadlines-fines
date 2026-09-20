import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { AuditLogEntry } from "../api/types";

const ACTION_LABELS: Record<string, string> = {
  STORE_CREATED: "Store added",
  STORE_UPDATED: "Store updated",
  STORE_DELETED: "Store deleted",
  SOURCE_CREATED: "Source added",
  SOURCE_UPDATED: "Source updated",
  SOURCE_DELETED: "Source deleted",
  COST_IMPORTED: "Costs imported",
  COST_UPDATED: "Cost updated",
  COD_CONFIG_UPDATED: "COD formula updated",
  PRICE_PUBLISHED: "Prices published",
  USER_CREATED: "Teammate added",
  USER_UPDATED: "Teammate updated",
  USER_DELETED: "Teammate removed",
};

export function AuditLog() {
  const [logs, setLogs] = useState<AuditLogEntry[] | null>(null);
  const [action, setAction] = useState("");
  const [search, setSearch] = useState("");

  async function refresh() {
    const params = new URLSearchParams();
    if (action) params.set("action", action);
    if (search.trim()) params.set("search", search.trim());
    const res = await api<AuditLogEntry[]>(`/audit-log?${params.toString()}`);
    setLogs(res);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, search]);

  return (
    <div>
      <div className="page-header">
        <h1>Audit log</h1>
      </div>

      <div className="filters-bar">
        <input placeholder="Search summary" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">All actions</option>
          {Object.entries(ACTION_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>

      {logs === null ? (
        <p className="center-loading">Loading…</p>
      ) : (
        <div className="table-wrap">
          <table className="pricing-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(l.createdAt).toLocaleString()}</td>
                  <td>{l.actor ? l.actor.name : <span className="muted">deleted user</span>}</td>
                  <td>
                    <span className="badge" style={{ background: "var(--info-bg)", color: "var(--primary)" }}>
                      {ACTION_LABELS[l.action] ?? l.action}
                    </span>
                  </td>
                  <td>{l.summary}</td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted" style={{ textAlign: "center", padding: 30 }}>
                    No activity yet.
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
