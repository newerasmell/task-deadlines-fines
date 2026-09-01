import { useEffect, useState } from "react";
import { api } from "../api/client";
import { ADMIN_ACTION_LABELS, STATUS_LABELS } from "../api/types";
import type { AuditLogEntry, Fine, Task } from "../api/types";
import { Avatar } from "../components/Avatar";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";

const actionBadgeClass: Record<AuditLogEntry["action"], string> = {
  TASK_CREATED: "badge badge-success",
  TASK_UPDATED: "badge badge-info",
  TASK_DELETED: "badge badge-danger",
  FINE_CREATED: "badge badge-danger",
  FINE_WAIVED: "badge",
};

export function Dashboard() {
  const { user } = useAuth();
  const { t, lang } = useI18n();
  const isAdmin = user?.role === "ADMIN";
  const [tasks, setTasks] = useState<Task[]>([]);
  const [fines, setFines] = useState<Fine[]>([]);
  const [recentActivity, setRecentActivity] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const promises: Promise<unknown>[] = [
      api<Task[]>("/tasks").then(setTasks),
      api<Fine[]>("/fines").then(setFines),
    ];
    if (isAdmin) {
      promises.push(api<AuditLogEntry[]>("/audit-log").then((logs) => setRecentActivity(logs.slice(0, 6))));
    }
    Promise.all(promises).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <p>{t("Зареждане…")}</p>;

  const locale = lang === "en" ? "en-GB" : "bg-BG";
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  const overdue = tasks.filter((t) => t.status === "OVERDUE");
  const dueToday = tasks.filter((t) => {
    if (t.status !== "PENDING" && t.status !== "IN_PROGRESS") return false;
    const d = new Date(t.deadline);
    return d >= todayStart && d < todayEnd;
  });
  const dueSoon = tasks.filter((t) => {
    if (t.status !== "PENDING" && t.status !== "IN_PROGRESS") return false;
    const hours = (new Date(t.deadline).getTime() - Date.now()) / 3600000;
    return hours >= 0 && hours <= 48;
  });
  const activeFines = fines.filter((f) => f.status === "ACTIVE");
  const totalFines = activeFines.reduce((sum, f) => sum + f.amount, 0);

  return (
    <div>
      <h1>{t("Табло")}</h1>
      <p className="muted">
        {t("Здравей, {name}.", { name: user?.name ?? "" })}{" "}
        {isAdmin ? t("Ето текущото състояние на екипа.") : t("Ето твоите задачи и срокове.")}
      </p>

      <div className="stat-grid">
        <div className="stat-card danger">
          <div className="stat-value">{overdue.length}</div>
          <div className="stat-label">{t("Просрочени задачи")}</div>
        </div>
        <div className="stat-card warning">
          <div className="stat-value">{dueToday.length}</div>
          <div className="stat-label">{t("С днешен срок")}</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{dueSoon.length}</div>
          <div className="stat-label">{t("Наближаващи срокове (48ч)")}</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">
            {totalFines.toFixed(2)} {activeFines[0]?.currency ?? "EUR"}
          </div>
          <div className="stat-label">{t("Активни глоби ({count})", { count: activeFines.length })}</div>
        </div>
      </div>

      <div className="dashboard-columns">
        <div>
          <h2>{t("Просрочени задачи")}</h2>
          {overdue.length === 0 ? (
            <p className="muted">{t("Няма просрочени задачи в момента.")}</p>
          ) : (
            <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("Задача")}</th>
                  <th>{t("Служител")}</th>
                  <th>{t("Срок")}</th>
                  <th>{t("Статус")}</th>
                </tr>
              </thead>
              <tbody>
                {overdue.map((tk) => (
                  <tr key={tk.id}>
                    <td data-label={t("Задача")}>{tk.title}</td>
                    <td className="person-cell" data-label={t("Служител")}>
                      <Avatar id={tk.assigneeId} name={tk.assignee.name} size={22} />
                      {tk.assignee.name}
                    </td>
                    <td data-label={t("Срок")}>{new Date(tk.deadline).toLocaleString(locale)}</td>
                    <td data-label={t("Статус")}>
                      <span className="badge badge-danger">{t(STATUS_LABELS[tk.status])}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}

          {dueToday.length > 0 && (
            <>
              <h2>{t("С днешен срок")}</h2>
              <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("Задача")}</th>
                    <th>{t("Служител")}</th>
                    <th>{t("Срок")}</th>
                  </tr>
                </thead>
                <tbody>
                  {dueToday.map((tk) => (
                    <tr key={tk.id}>
                      <td data-label={t("Задача")}>{tk.title}</td>
                      <td className="person-cell" data-label={t("Служител")}>
                        <Avatar id={tk.assigneeId} name={tk.assignee.name} size={22} />
                        {tk.assignee.name}
                      </td>
                      <td data-label={t("Срок")}>{new Date(tk.deadline).toLocaleString(locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </>
          )}
        </div>

        {isAdmin && recentActivity.length > 0 && (
          <div className="activity-panel">
            <h2>{t("Последна активност")}</h2>
            <ul className="activity-list">
              {recentActivity.map((l) => (
                <li key={l.id}>
                  <span className={actionBadgeClass[l.action]}>{t(ADMIN_ACTION_LABELS[l.action])}</span>
                  <div className="activity-summary">{l.summary}</div>
                  <div className="muted small">
                    {l.actor.name} · {new Date(l.createdAt).toLocaleString(locale)}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
