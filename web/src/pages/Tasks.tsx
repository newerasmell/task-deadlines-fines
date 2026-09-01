import { Fragment, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { api, apiUpload, attachmentUrl } from "../api/client";
import { PRIORITY_LABELS, STATUS_LABELS } from "../api/types";
import type { Priority, Task, TaskSubmission, User } from "../api/types";
import { Avatar } from "../components/Avatar";
import { IconSearch } from "../components/icons";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";
import { colorForId } from "../lib/colors";

const statusBadgeClass: Record<Task["status"], string> = {
  PENDING: "badge",
  IN_PROGRESS: "badge badge-info",
  PENDING_REVIEW: "badge badge-info",
  DONE: "badge badge-success",
  OVERDUE: "badge badge-danger",
  CANCELLED: "badge",
};

const BOARD_COLUMNS: { status: Task["status"]; label: string; color: string; droppable: boolean }[] = [
  { status: "PENDING", label: "Чакаща", color: "#9d99b9", droppable: true },
  { status: "IN_PROGRESS", label: "В процес", color: "#579bfc", droppable: true },
  { status: "PENDING_REVIEW", label: "За преглед", color: "#a25ddc", droppable: false },
  { status: "OVERDUE", label: "Просрочена", color: "#e2445c", droppable: true },
  { status: "DONE", label: "Завършена", color: "#00c875", droppable: true },
];

const PRIORITY_COLORS: Record<Priority, string> = {
  LOW: "#9d99b9",
  MEDIUM: "#579bfc",
  HIGH: "#fdab3d",
  CRITICAL: "#e2445c",
};

type ExpandedMode = "submit" | "review" | "edit" | null;
type Tab = "active" | "completed";
type ViewMode = "board" | "list";

export function Tasks() {
  const { user } = useAuth();
  const { t, lang } = useI18n();
  const locale = lang === "en" ? "en-GB" : "bg-BG";
  const isAdmin = user?.role === "ADMIN";
  const [tasks, setTasks] = useState<Task[]>([]);
  const [employees, setEmployees] = useState<User[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<{ taskId: string; mode: ExpandedMode } | null>(null);
  const [tab, setTab] = useState<Tab>("active");
  const [view, setView] = useState<ViewMode>(isAdmin ? "board" : "list");
  const [search, setSearch] = useState("");
  const [filterEmployee, setFilterEmployee] = useState("");
  const [filterPriority, setFilterPriority] = useState<Priority | "">("");
  const [filterStatus, setFilterStatus] = useState<Task["status"] | "">("");

  async function refresh() {
    const t = await api<Task[]>("/tasks");
    setTasks(t);
  }

  useEffect(() => {
    const promises: Promise<unknown>[] = [refresh()];
    if (isAdmin) promises.push(api<User[]>("/users").then(setEmployees));
    Promise.all(promises).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startWork(id: string) {
    await api(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status: "IN_PROGRESS" }) });
    refresh();
  }

  async function deleteTask(tk: Task) {
    if (!window.confirm(t('Наистина ли да изтрия "{title}"? Действието се записва в дневника.', { title: tk.title }))) return;
    await api(`/tasks/${tk.id}`, { method: "DELETE" });
    refresh();
  }

  function toggleExpanded(taskId: string, mode: ExpandedMode) {
    setExpanded((cur) => (cur?.taskId === taskId && cur.mode === mode ? null : { taskId, mode }));
  }

  async function handleBoardStatusChange(taskId: string, status: Task["status"]) {
    await api(`/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify({ status }) });
    refresh();
  }

  if (loading) return <p>{t("Зареждане…")}</p>;

  const visibleTasks = tasks
    .filter((tk) => (tab === "completed" ? tk.status === "DONE" : tk.status !== "DONE"))
    .filter((tk) => !search || tk.title.toLowerCase().includes(search.toLowerCase()))
    .filter((tk) => !filterEmployee || tk.assigneeId === filterEmployee)
    .filter((tk) => !filterPriority || tk.priority === filterPriority)
    .filter((tk) => !filterStatus || tk.status === filterStatus);
  const expandedTask = expanded ? tasks.find((tk) => tk.id === expanded.taskId) : undefined;

  return (
    <div>
      <div className="page-header">
        <h1>{t("Задачи")}</h1>
        {isAdmin && (
          <button
            onClick={() => {
              setShowForm((s) => !s);
              setExpanded(null);
            }}
          >
            {showForm ? t("Затвори") : t("+ Нова задача")}
          </button>
        )}
      </div>

      {isAdmin && showForm && (
        <TaskForm
          employees={employees}
          onSaved={() => {
            setShowForm(false);
            refresh();
          }}
        />
      )}

      {isAdmin && (
        <div className="tabs">
          <button className={view === "board" ? "active" : ""} onClick={() => setView("board")}>
            {t("Табло")}
          </button>
          <button className={view === "list" ? "active" : ""} onClick={() => setView("list")}>
            {t("Списък")}
          </button>
        </div>
      )}

      {isAdmin && view === "board" ? (
        <>
          <TaskBoard
            tasks={tasks}
            onEdit={(taskId) => toggleExpanded(taskId, "edit")}
            onStatusChange={handleBoardStatusChange}
          />
          {expanded && expandedTask && expanded.mode === "edit" && (
            <TaskForm
              task={expandedTask}
              employees={employees}
              onSaved={() => {
                setExpanded(null);
                refresh();
              }}
              onCancel={() => setExpanded(null)}
            />
          )}
        </>
      ) : (
        <>
          <div className="tabs">
            <button className={tab === "active" ? "active" : ""} onClick={() => setTab("active")}>
              {t("Активни")}
            </button>
            <button className={tab === "completed" ? "active" : ""} onClick={() => setTab("completed")}>
              {t("Завършени")}
            </button>
          </div>

          <div className="filter-bar">
            <div className="search-input">
              <IconSearch size={16} />
              <input placeholder={t("Търсене по заглавие…")} value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {isAdmin && (
              <select value={filterEmployee} onChange={(e) => setFilterEmployee(e.target.value)}>
                <option value="">{t("Всички служители")}</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            )}
            <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value as Priority | "")}>
              <option value="">{t("Всички приоритети")}</option>
              {(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as Priority[]).map((p) => (
                <option key={p} value={p}>
                  {t(PRIORITY_LABELS[p])}
                </option>
              ))}
            </select>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as Task["status"] | "")}>
              <option value="">{t("Всички статуси")}</option>
              {(Object.keys(STATUS_LABELS) as Task["status"][])
                .filter((s) => s !== "CANCELLED")
                .map((s) => (
                  <option key={s} value={s}>
                    {t(STATUS_LABELS[s])}
                  </option>
                ))}
            </select>
          </div>

          <table className="table">
            <thead>
              <tr>
                <th>{t("Задача")}</th>
                <th>{t("Служител")}</th>
                <th>Owner</th>
                <th>{t("Срок")}</th>
                <th>{t("Приоритет")}</th>
                <th>{t("Статус")}</th>
                <th>{t("Глоби")}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleTasks.map((tk) => {
                const activeFines = (tk.fines ?? []).filter((f) => f.status === "ACTIVE");
                const fineTotal = activeFines.reduce((s, f) => s + f.amount, 0);
                const isAssignee = tk.assigneeId === user?.id;
                const isOwner = tk.ownerId === user?.id;
                const canSubmit = isAssignee && (tk.status === "PENDING" || tk.status === "IN_PROGRESS");
                const canReview = (isOwner || isAdmin) && tk.status === "PENDING_REVIEW";
                const isExpanded = expanded?.taskId === tk.id;

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
                      <td className="person-cell">
                        <Avatar id={tk.assigneeId} name={tk.assignee.name} size={22} />
                        {tk.assignee.name}
                      </td>
                      <td>{tk.owner?.name ?? "—"}</td>
                      <td>{new Date(tk.deadline).toLocaleString(locale)}</td>
                      <td>{t(PRIORITY_LABELS[tk.priority])}</td>
                      <td>
                        <span className={statusBadgeClass[tk.status]}>{t(STATUS_LABELS[tk.status])}</span>
                      </td>
                      <td>{fineTotal > 0 ? `${fineTotal.toFixed(2)} ${activeFines[0].currency}` : "—"}</td>
                      <td className="row-actions">
                        {isAssignee && tk.status === "PENDING" && (
                          <button className="small-btn" onClick={() => startWork(tk.id)}>
                            {t("Започни")}
                          </button>
                        )}
                        {canSubmit && (
                          <button className="small-btn" onClick={() => toggleExpanded(tk.id, "submit")}>
                            {isExpanded && expanded?.mode === "submit" ? t("Затвори") : t("Подай за преглед")}
                          </button>
                        )}
                        {canReview && (
                          <button className="small-btn" onClick={() => toggleExpanded(tk.id, "review")}>
                            {isExpanded && expanded?.mode === "review" ? t("Затвори") : t("Прегледай")}
                          </button>
                        )}
                        {isAdmin && (
                          <button className="small-btn" onClick={() => toggleExpanded(tk.id, "edit")}>
                            {isExpanded && expanded?.mode === "edit" ? t("Затвори") : t("Редактирай")}
                          </button>
                        )}
                        {isAdmin && (
                          <button className="small-btn" onClick={() => deleteTask(tk)}>
                            {t("Изтрий")}
                          </button>
                        )}
                      </td>
                    </tr>
                    {isExpanded && expanded?.mode === "submit" && (
                      <tr>
                        <td colSpan={8}>
                          <SubmitForm
                            taskId={tk.id}
                            onDone={() => {
                              setExpanded(null);
                              refresh();
                            }}
                          />
                        </td>
                      </tr>
                    )}
                    {isExpanded && expanded?.mode === "review" && (
                      <tr>
                        <td colSpan={8}>
                          <ReviewPanel
                            taskId={tk.id}
                            onDone={() => {
                              setExpanded(null);
                              refresh();
                            }}
                          />
                        </td>
                      </tr>
                    )}
                    {isExpanded && expanded?.mode === "edit" && (
                      <tr>
                        <td colSpan={8}>
                          <TaskForm
                            task={tk}
                            employees={employees}
                            onSaved={() => {
                              setExpanded(null);
                              refresh();
                            }}
                            onCancel={() => setExpanded(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {visibleTasks.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    {tab === "completed" ? t("Няма завършени задачи.") : t("Няма активни задачи.")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function TaskBoard({
  tasks,
  onEdit,
  onStatusChange,
}: {
  tasks: Task[];
  onEdit: (taskId: string) => void;
  onStatusChange: (taskId: string, status: Task["status"]) => void;
}) {
  const { t, lang } = useI18n();
  const locale = lang === "en" ? "en-GB" : "bg-BG";
  const [dragTaskId, setDragTaskId] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggleCollapsed(empId: string) {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(empId)) next.delete(empId);
      else next.add(empId);
      return next;
    });
  }

  const grouped = new Map<string, Task[]>();
  for (const tk of tasks) {
    if (tk.status === "CANCELLED") continue;
    const list = grouped.get(tk.assigneeId) ?? [];
    list.push(tk);
    grouped.set(tk.assigneeId, list);
  }
  const employeeIds = [...grouped.keys()].sort((a, b) =>
    grouped.get(a)![0].assignee.name.localeCompare(grouped.get(b)![0].assignee.name, "bg")
  );

  if (employeeIds.length === 0) return <p className="muted">{t("Няма задачи.")}</p>;

  return (
    <div className="board">
      {employeeIds.map((empId) => {
        const empTasks = grouped.get(empId)!;
        const color = colorForId(empId);
        const isCollapsed = collapsed.has(empId);
        return (
          <div className="board-group" key={empId} style={{ borderLeftColor: color }}>
            <div
              className="board-group-header board-group-header-clickable"
              onClick={() => toggleCollapsed(empId)}
              title={isCollapsed ? t("Разгъни") : t("Свий")}
            >
              <span className={`board-group-chevron${isCollapsed ? " board-group-chevron-collapsed" : ""}`}>▾</span>
              <span className="board-group-dot" style={{ background: color }} />
              <span style={{ color }}>{empTasks[0].assignee.name}</span>
              <span className="board-group-count">{empTasks.length}</span>
            </div>
            {!isCollapsed && (
            <div className="board-columns">
              {BOARD_COLUMNS.map((col) => {
                const colTasks = empTasks.filter((tk) => tk.status === col.status);
                const key = `${empId}:${col.status}`;
                const isDragOver = dragOverKey === key;
                return (
                  <div
                    key={col.status}
                    className={`board-column${isDragOver ? " board-column-over" : ""}`}
                    onDragOver={(e) => {
                      if (!col.droppable || !dragTaskId) return;
                      e.preventDefault();
                      setDragOverKey(key);
                    }}
                    onDragLeave={() => setDragOverKey((cur) => (cur === key ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverKey(null);
                      if (!col.droppable || !dragTaskId) return;
                      onStatusChange(dragTaskId, col.status);
                      setDragTaskId(null);
                    }}
                  >
                    <div className="board-column-header" style={{ borderTopColor: col.color }}>
                      {t(col.label)} <span className="muted small">({colTasks.length})</span>
                    </div>
                    <div className="board-column-body">
                      {colTasks.map((tk) => {
                        const activeFines = (tk.fines ?? []).filter((f) => f.status === "ACTIVE");
                        const fineTotal = activeFines.reduce((s, f) => s + f.amount, 0);
                        return (
                          <div
                            key={tk.id}
                            className="board-card"
                            style={{ borderLeftColor: PRIORITY_COLORS[tk.priority] }}
                            draggable
                            onDragStart={() => setDragTaskId(tk.id)}
                            onDragEnd={() => {
                              setDragTaskId(null);
                              setDragOverKey(null);
                            }}
                            onClick={() => onEdit(tk.id)}
                            title={t("Кликни за редакция")}
                          >
                            <div className="board-card-title">
                              {tk.title}
                              {tk.templateId && <span title={t("Повтаряща се задача")}> ↻</span>}
                            </div>
                            <div className="board-card-meta muted small">
                              {new Date(tk.deadline).toLocaleDateString(locale)}
                              {tk.owner && ` · Owner: ${tk.owner.name}`}
                            </div>
                            {fineTotal > 0 && (
                              <span className="badge badge-danger board-card-fine">
                                {fineTotal.toFixed(2)} {activeFines[0].currency}
                              </span>
                            )}
                          </div>
                        );
                      })}
                      {colTasks.length === 0 && <div className="board-column-empty" />}
                    </div>
                  </div>
                );
              })}
            </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SubmitForm({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<FileList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const formData = new FormData();
      if (note) formData.append("note", note);
      if (files) Array.from(files).forEach((f) => formData.append("attachments", f));
      await apiUpload(`/tasks/${taskId}/submit`, formData);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <label>
        {t("Описание / обяснение на свършеното")}
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder={t("Какво направи, къде е резултатът…")} />
      </label>
      <label>
        {t("Прикачи скрийншоти / снимки (по избор, до 5 файла)")}
        <input type="file" accept="image/*,application/pdf" multiple onChange={(e) => setFiles(e.target.files)} />
      </label>
      {error && <div className="error-text">{error}</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? t("Изпращане…") : t("Подай за преглед")}
      </button>
    </form>
  );
}

function ReviewPanel({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const { t, lang } = useI18n();
  const locale = lang === "en" ? "en-GB" : "bg-BG";
  const [task, setTask] = useState<Task | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<Task>(`/tasks/${taskId}`).then(setTask);
  }, [taskId]);

  if (!task) return <p className="muted">{t("Зареждане…")}</p>;

  const submission: TaskSubmission | undefined = task.submissions?.find((s) => s.reviewStatus === "PENDING");
  if (!submission) return <p className="muted">{t("Няма чакащо подаване.")}</p>;

  async function approve() {
    setError(null);
    setSubmitting(true);
    try {
      await api(`/tasks/${taskId}/submissions/${submission!.id}/approve`, {
        method: "POST",
        body: JSON.stringify({ reviewNote: reviewNote || undefined }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  async function reject() {
    if (!reviewNote.trim()) {
      setError(t("Обясни защо не одобряваш работата."));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await api(`/tasks/${taskId}/submissions/${submission!.id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reviewNote }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <p>
        <strong>{submission.submittedBy.name}</strong> {t("подаде на")} {new Date(submission.createdAt).toLocaleString(locale)}
      </p>
      {submission.note && <p>{submission.note}</p>}
      {submission.attachments.length > 0 && (
        <div className="attachment-grid">
          {submission.attachments.map((a) => {
            const url = attachmentUrl(taskId, submission.id, a.id);
            const isImage = a.mimeType.startsWith("image/");
            return isImage ? (
              <a key={a.id} href={url} target="_blank" rel="noreferrer">
                <img src={url} alt={a.originalName} className="attachment-thumb" />
              </a>
            ) : (
              <a key={a.id} href={url} target="_blank" rel="noreferrer" className="attachment-file">
                📄 {a.originalName}
              </a>
            );
          })}
        </div>
      )}
      <label>
        {t("Бележка при преглед (задължителна при отхвърляне)")}
        <textarea value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} rows={2} />
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="button" onClick={approve} disabled={submitting}>
          {t("Одобри")}
        </button>
        <button type="button" className="secondary" onClick={reject} disabled={submitting}>
          {t("Отхвърли")}
        </button>
      </div>
    </div>
  );
}

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function TaskForm({
  task,
  employees,
  onSaved,
  onCancel,
}: {
  task?: Task;
  employees: User[];
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const isEdit = Boolean(task);
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [assigneeId, setAssigneeId] = useState(task?.assigneeId ?? employees[0]?.id ?? "");
  const [ownerId, setOwnerId] = useState(task?.ownerId ?? "");
  const [deadline, setDeadline] = useState(task ? toLocalInputValue(task.deadline) : "");
  const [priority, setPriority] = useState<Priority>(task?.priority ?? "MEDIUM");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const employeeOptions = useMemo(
    () => employees.filter((e) => e.active || e.id === assigneeId || e.id === ownerId),
    [employees, assigneeId, ownerId]
  );

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!assigneeId) {
      setError(t("Избери служител."));
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        title,
        description: description || undefined,
        assigneeId,
        ownerId: ownerId || null,
        deadline: new Date(deadline).toISOString(),
        priority,
      };
      if (isEdit) {
        await api(`/tasks/${task!.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api("/tasks", { method: "POST", body: JSON.stringify({ ...body, ownerId: ownerId || undefined }) });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <label>
        {t("Заглавие")}
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label>
        {t("Описание")}
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </label>
      <div className="form-row">
        <label>
          {t("Служител")}
          <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} required>
            <option value="" disabled>
              {t("Избери…")}
            </option>
            {employeeOptions.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Owner (проверява изпълнението)")}
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">{t("Без — admin преглежда")}</option>
            {employeeOptions.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Срок")}
          <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} required />
        </label>
        <label>
          {t("Приоритет")}
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as Priority[]).map((p) => (
              <option key={p} value={p}>
                {t(PRIORITY_LABELS[p])}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? t("Записване…") : isEdit ? t("Запази промените") : t("Създай задача")}
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            {t("Отказ")}
          </button>
        )}
      </div>
    </form>
  );
}
