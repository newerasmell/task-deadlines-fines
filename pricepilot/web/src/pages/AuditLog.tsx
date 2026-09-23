import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { AuditLogEntry } from "../api/types";
import { useT } from "../i18n/I18nContext";

const ACTION_LABELS: Record<string, string> = {
  STORE_CREATED: "Магазин добавен",
  STORE_UPDATED: "Магазин обновен",
  STORE_DELETED: "Магазин изтрит",
  SOURCE_CREATED: "Източник добавен",
  SOURCE_UPDATED: "Източник обновен",
  SOURCE_DELETED: "Източник изтрит",
  COST_IMPORTED: "Себестойности импортирани",
  COST_UPDATED: "Себестойност обновена",
  COD_CONFIG_UPDATED: "COD формула обновена",
  PRICE_PUBLISHED: "Цени публикувани",
  USER_CREATED: "Колега добавен",
  USER_UPDATED: "Колега обновен",
  USER_DELETED: "Колега премахнат",
};

export function AuditLog() {
  const t = useT();
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
        <h1>{t("Одит лог")}</h1>
      </div>

      <div className="filters-bar">
        <input placeholder={t("Търсене в резюмето")} value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="">{t("Всички действия")}</option>
          {Object.entries(ACTION_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {t(label)}
            </option>
          ))}
        </select>
      </div>

      {logs === null ? (
        <p className="center-loading">{t("Зареждане…")}</p>
      ) : (
        <div className="table-wrap">
          <table className="pricing-table">
            <thead>
              <tr>
                <th>{t("Кога")}</th>
                <th>{t("Кой")}</th>
                <th>{t("Действие")}</th>
                <th>{t("Детайли")}</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(l.createdAt).toLocaleString()}</td>
                  <td>{l.actor ? l.actor.name : <span className="muted">{t("изтрит потребител")}</span>}</td>
                  <td>
                    <span className="badge" style={{ background: "var(--info-bg)", color: "var(--primary)" }}>
                      {t(ACTION_LABELS[l.action] ?? l.action)}
                    </span>
                  </td>
                  <td>{l.summary}</td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted" style={{ textAlign: "center", padding: 30 }}>
                    {t("Все още няма активност.")}
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
