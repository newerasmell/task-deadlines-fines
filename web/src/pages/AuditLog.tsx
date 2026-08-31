import { Fragment, useEffect, useState } from "react";
import { api } from "../api/client";
import { ADMIN_ACTION_LABELS } from "../api/types";
import type { AuditLogEntry } from "../api/types";

const actionBadgeClass: Record<AuditLogEntry["action"], string> = {
  TASK_CREATED: "badge badge-success",
  TASK_UPDATED: "badge badge-info",
  TASK_DELETED: "badge badge-danger",
  FINE_CREATED: "badge badge-danger",
  FINE_WAIVED: "badge",
};

export function AuditLog() {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    api<AuditLogEntry[]>("/audit-log").then(setLogs).finally(() => setLoading(false));
  }, []);

  if (loading) return <p>Зареждане…</p>;

  return (
    <div>
      <h1>Дневник на действията</h1>
      <p className="muted">
        Всяко създаване, редактиране или изтриване на задача, и всяка наложена/анулирана глоба от администратор,
        се записва тук — за да няма нещо, което просто изчезва без следа.
      </p>

      <table className="table">
        <thead>
          <tr>
            <th>Кога</th>
            <th>Кой</th>
            <th>Действие</th>
            <th>Какво</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <Fragment key={l.id}>
              <tr>
                <td>{new Date(l.createdAt).toLocaleString("bg-BG")}</td>
                <td>{l.actor.name}</td>
                <td>
                  <span className={actionBadgeClass[l.action]}>{ADMIN_ACTION_LABELS[l.action]}</span>
                </td>
                <td>{l.summary}</td>
                <td>
                  {l.details && (
                    <button className="small-btn" onClick={() => setExpandedId(expandedId === l.id ? null : l.id)}>
                      {expandedId === l.id ? "Скрий" : "Детайли"}
                    </button>
                  )}
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
                Няма записи.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
