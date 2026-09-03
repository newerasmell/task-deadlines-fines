import { Fragment, useEffect, useState } from "react";
import { api } from "../api/client";
import { PRIORITY_LABELS, STATUS_LABELS } from "../api/types";
import type { Task } from "../api/types";
import { RowMenu, RowMenuItem } from "../components/RowMenu";
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
  const [expandedDescIds, setExpandedDescIds] = useState<Set<string>>(new Set());

  function toggleDesc(id: string) {
    setExpandedDescIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
        <div
          className="grid-table"
          style={{ gridTemplateColumns: "minmax(220px, 2fr) 120px 160px 100px 110px 90px 56px" }}
        >
          <div className="grid-table-header">{t("Задача")}</div>
          <div className="grid-table-header">Owner</div>
          <div className="grid-table-header">{t("Срок")}</div>
          <div className="grid-table-header">{t("Приоритет")}</div>
          <div className="grid-table-header">{t("Статус")}</div>
          <div className="grid-table-header">{t("Глоби")}</div>
          <div className="grid-table-header"></div>

          {visible.map((tk) => {
            const activeFines = (tk.fines ?? []).filter((f) => f.status === "ACTIVE");
            const fineTotal = activeFines.reduce((s, f) => s + f.amount, 0);
            const canSubmit = tk.status === "PENDING" || tk.status === "IN_PROGRESS" || tk.status === "OVERDUE";
            const isSubmitting = submittingId === tk.id;
            return (
              <Fragment key={tk.id}>
                <div className="grid-row">
                  <div className="grid-cell" data-label={t("Задача")}>
                    <div
                      className="task-cell-clickable"
                      onClick={() => toggleDesc(tk.id)}
                      role="button"
                      tabIndex={0}
                      title={t("Покажи/скрий пълното описание")}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleDesc(tk.id);
                        }
                      }}
                    >
                      <div className={`cell-title${expandedDescIds.has(tk.id) ? " expanded" : ""}`}>
                        {tk.title}
                        {tk.templateId && (
                          <span className="badge" title={t("Повтаряща се задача")}>
                            ↻
                          </span>
                        )}
                        {tk.projectId && (
                          <span className="badge" title={t("Стъпка {order} от проект", { order: tk.chainOrder ?? "?" })}>
                            🔗 {tk.chainOrder}
                          </span>
                        )}
                      </div>
                      <div className={`muted small cell-description${expandedDescIds.has(tk.id) ? " expanded" : ""}`}>
                        {tk.description}
                      </div>
                    </div>
                  </div>
                  <div className="grid-cell" data-label="Owner">
                    {tk.owner?.name ?? "—"}
                  </div>
                  <div className="grid-cell" data-label={t("Срок")}>
                    {tk.status === "BLOCKED" ? (
                      <span className="muted">{t("Чака предходна стъпка")}</span>
                    ) : (
                      new Date(tk.deadline).toLocaleString(locale)
                    )}
                  </div>
                  <div className="grid-cell" data-label={t("Приоритет")}>
                    {t(PRIORITY_LABELS[tk.priority])}
                  </div>
                  <div className="grid-cell" data-label={t("Статус")}>
                    <span className={statusBadgeClass[tk.status]}>{t(STATUS_LABELS[tk.status])}</span>
                  </div>
                  <div className="grid-cell" data-label={t("Глоби")}>
                    {fineTotal > 0 ? `${fineTotal.toFixed(2)} ${activeFines[0].currency}` : "—"}
                  </div>
                  <div className="grid-cell grid-cell-actions">
                    <RowMenu label={t("Действия")}>
                      {tk.status === "PENDING" && (
                        <RowMenuItem onClick={() => startWork(tk.id)}>{t("Започни")}</RowMenuItem>
                      )}
                      {canSubmit && (
                        <RowMenuItem onClick={() => setSubmittingId(isSubmitting ? null : tk.id)}>
                          {isSubmitting ? t("Затвори") : t("Подай за преглед")}
                        </RowMenuItem>
                      )}
                    </RowMenu>
                  </div>
                </div>
                {isSubmitting && (
                  <div className="grid-cell-full">
                    <SubmitForm
                      taskId={tk.id}
                      onDone={() => {
                        setSubmittingId(null);
                        refresh();
                      }}
                    />
                  </div>
                )}
              </Fragment>
            );
          })}
          {visible.length === 0 && (
            <div className="grid-cell-full muted">
              {tab === "completed" ? t("Няма завършени задачи.") : t("Няма активни задачи.")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
