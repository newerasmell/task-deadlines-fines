import { Fragment, useEffect, useState } from "react";
import { api } from "../api/client";
import { PRIORITY_LABELS, STATUS_LABELS } from "../api/types";
import type { Task } from "../api/types";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";
import { SubmitForm, statusBadgeClass } from "./Tasks";

type Tab = "active" | "completed";

export function MyTasks() {
  const { user } = useAuth();
  const { t, lang } = useI18n();
  const locale = lang === "en" ? "en-GB" : "bg-BG";
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("active");
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  async function refresh() {
    const all = await api<Task[]>("/tasks");
    setTasks(all.filter((tk) => tk.assigneeId === user?.id));
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startWork(id: string) {
    await api(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status: "IN_PROGRESS" }) });
    refresh();
  }

  if (loading) return <p>{t("Зареждане…")}</p>;

  const visible = tasks.filter((tk) => (tab === "completed" ? tk.status === "DONE" : tk.status !== "DONE"));

  return (
    <div>
      <div className="page-header">
        <h1>{t("Моите задачи")}</h1>
      </div>
      <p className="muted">{t("Само задачите, за които си изпълнител — независимо от ролята ти в системата.")}</p>

      <div className="tabs">
        <button className={tab === "active" ? "active" : ""} onClick={() => setTab("active")}>
          {t("Активни")}
        </button>
        <button className={tab === "completed" ? "active" : ""} onClick={() => setTab("completed")}>
          {t("Завършени")}
        </button>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t("Задача")}</th>
              <th>Owner</th>
              <th>{t("Срок")}</th>
              <th>{t("Приоритет")}</th>
              <th>{t("Статус")}</th>
              <th>{t("Глоби")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((tk) => {
              const activeFines = (tk.fines ?? []).filter((f) => f.status === "ACTIVE");
              const fineTotal = activeFines.reduce((s, f) => s + f.amount, 0);
              const canSubmit = tk.status === "PENDING" || tk.status === "IN_PROGRESS";
              const isSubmitting = submittingId === tk.id;
              return (
                <Fragment key={tk.id}>
                  <tr>
                    <td>
                      <div>
                        {tk.title}
                        {tk.templateId && (
                          <span className="badge" title={t("Повтаряща се задача")}>
                            ↻
                          </span>
                        )}
                      </div>
                      {tk.description && <div className="muted small">{tk.description}</div>}
                    </td>
                    <td>{tk.owner?.name ?? "—"}</td>
                    <td>{new Date(tk.deadline).toLocaleString(locale)}</td>
                    <td>{t(PRIORITY_LABELS[tk.priority])}</td>
                    <td>
                      <span className={statusBadgeClass[tk.status]}>{t(STATUS_LABELS[tk.status])}</span>
                    </td>
                    <td>{fineTotal > 0 ? `${fineTotal.toFixed(2)} ${activeFines[0].currency}` : "—"}</td>
                    <td className="row-actions">
                      {tk.status === "PENDING" && (
                        <button className="small-btn" onClick={() => startWork(tk.id)}>
                          {t("Започни")}
                        </button>
                      )}
                      {canSubmit && (
                        <button className="small-btn" onClick={() => setSubmittingId(isSubmitting ? null : tk.id)}>
                          {isSubmitting ? t("Затвори") : t("Подай за преглед")}
                        </button>
                      )}
                    </td>
                  </tr>
                  {isSubmitting && (
                    <tr>
                      <td colSpan={7}>
                        <SubmitForm
                          taskId={tk.id}
                          onDone={() => {
                            setSubmittingId(null);
                            refresh();
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  {tab === "completed" ? t("Няма завършени задачи.") : t("Няма активни задачи.")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
