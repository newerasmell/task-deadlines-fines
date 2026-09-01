import { Fragment, useEffect, useState } from "react";
import { api } from "../api/client";
import { ADMIN_ACTION_LABELS } from "../api/types";
import type { AuditLogEntry } from "../api/types";
import { Avatar } from "../components/Avatar";
import { useI18n } from "../i18n/I18nContext";

const actionBadgeClass: Record<AuditLogEntry["action"], string> = {
  TASK_CREATED: "badge badge-success",
  TASK_UPDATED: "badge badge-info",
  TASK_DELETED: "badge badge-danger",
  FINE_CREATED: "badge badge-danger",
  FINE_WAIVED: "badge",
};

export function AuditLog() {
  const { t, lang } = useI18n();
  const locale = lang === "en" ? "en-GB" : "bg-BG";
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    api<AuditLogEntry[]>("/audit-log").then(setLogs).finally(() => setLoading(false));
  }, []);

  if (loading) return <p>{t("Зареждане…")}</p>;

  return (
    <div>
      <h1>{t("Дневник на действията")}</h1>
      <p className="muted">
        {t(
          "Всяко създаване, редактиране или изтриване на задача, и всяка наложена/анулирана глоба от администратор, се записва тук — за да няма нещо, което просто изчезва без следа."
        )}
      </p>

      <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t("Кога")}</th>
            <th>{t("Кой")}</th>
            <th>{t("Действие")}</th>
            <th>{t("Какво")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <Fragment key={l.id}>
              <tr>
                <td data-label={t("Кога")}>{new Date(l.createdAt).toLocaleString(locale)}</td>
                <td className="person-cell" data-label={t("Кой")}>
                  <div className="person-cell-group">
                    <Avatar id={l.actor.id} name={l.actor.name} size={22} />
                    {l.actor.name}
                  </div>
                </td>
                <td data-label={t("Действие")}>
                  <span className={actionBadgeClass[l.action]}>{t(ADMIN_ACTION_LABELS[l.action])}</span>
                </td>
                <td data-label={t("Какво")}>{l.summary}</td>
                <td className="row-actions">
                  <div className="row-actions-group">
                    {l.details && (
                      <button className="small-btn" onClick={() => setExpandedId(expandedId === l.id ? null : l.id)}>
                        {expandedId === l.id ? t("Скрий") : t("Детайли")}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
              {expandedId === l.id && l.details && (
                <tr>
                  <td colSpan={5}>
                    <pre className="details-block">{JSON.stringify(JSON.parse(l.details), null, 2)}</pre>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {logs.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                {t("Няма записи.")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}
