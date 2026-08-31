import { Fragment, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, apiUpload, attachmentUrl } from "../api/client";
import { PRIORITY_LABELS, STATUS_LABELS } from "../api/types";
import type { Priority, Task, TaskSubmission, User } from "../api/types";
import { useAuth } from "../context/AuthContext";

const statusBadgeClass: Record<Task["status"], string> = {
  PENDING: "badge",
  IN_PROGRESS: "badge badge-info",
  PENDING_REVIEW: "badge badge-info",
  DONE: "badge badge-success",
  OVERDUE: "badge badge-danger",
  CANCELLED: "badge",
};

type ExpandedMode = "submit" | "review" | "edit" | null;
type Tab = "active" | "completed";

export function Tasks() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const [tasks, setTasks] = useState<Task[]>([]);
  const [employees, setEmployees] = useState<User[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<{ taskId: string; mode: ExpandedMode } | null>(null);
  const [tab, setTab] = useState<Tab>("active");

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

  async function deleteTask(t: Task) {
    if (!window.confirm(`Наистина ли да изтрия "${t.title}"? Действието се записва в дневника.`)) return;
    await api(`/tasks/${t.id}`, { method: "DELETE" });
    refresh();
  }

  function toggleExpanded(taskId: string, mode: ExpandedMode) {
    setExpanded((cur) => (cur?.taskId === taskId && cur.mode === mode ? null : { taskId, mode }));
  }

  if (loading) return <p>Зареждане…</p>;

  const visibleTasks = tasks.filter((t) => (tab === "completed" ? t.status === "DONE" : t.status !== "DONE"));

  return (
    <div>
      <div className="page-header">
        <h1>Задачи</h1>
        {isAdmin && (
          <button
            onClick={() => {
              setShowForm((s) => !s);
              setExpanded(null);
            }}
          >
            {showForm ? "Затвори" : "+ Нова задача"}
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

      <div className="tabs">
        <button className={tab === "active" ? "active" : ""} onClick={() => setTab("active")}>
          Активни
        </button>
        <button className={tab === "completed" ? "active" : ""} onClick={() => setTab("completed")}>
          Завършени
        </button>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Задача</th>
            <th>Служител</th>
            <th>Owner</th>
            <th>Срок</th>
            <th>Приоритет</th>
            <th>Статус</th>
            <th>Глоби</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visibleTasks.map((t) => {
            const activeFines = (t.fines ?? []).filter((f) => f.status === "ACTIVE");
            const fineTotal = activeFines.reduce((s, f) => s + f.amount, 0);
            const isAssignee = t.assigneeId === user?.id;
            const isOwner = t.ownerId === user?.id;
            const canSubmit = isAssignee && (t.status === "PENDING" || t.status === "IN_PROGRESS");
            const canReview = (isOwner || isAdmin) && t.status === "PENDING_REVIEW";
            const isExpanded = expanded?.taskId === t.id;

            return (
              <Fragment key={t.id}>
                <tr>
                  <td>
                    <div>
                      {t.title}
                      {t.templateId && (
                        <span className="badge" title="Повтаряща се задача">
                          ↻
                        </span>
                      )}
                    </div>
                    {t.description && <div className="muted small">{t.description}</div>}
                  </td>
                  <td>{t.assignee.name}</td>
                  <td>{t.owner?.name ?? "—"}</td>
                  <td>{new Date(t.deadline).toLocaleString("bg-BG")}</td>
                  <td>{PRIORITY_LABELS[t.priority]}</td>
                  <td>
                    <span className={statusBadgeClass[t.status]}>{STATUS_LABELS[t.status]}</span>
                  </td>
                  <td>{fineTotal > 0 ? `${fineTotal.toFixed(2)} ${activeFines[0].currency}` : "—"}</td>
                  <td className="row-actions">
                    {isAssignee && t.status === "PENDING" && (
                      <button className="small-btn" onClick={() => startWork(t.id)}>
                        Започни
                      </button>
                    )}
                    {canSubmit && (
                      <button className="small-btn" onClick={() => toggleExpanded(t.id, "submit")}>
                        {isExpanded && expanded?.mode === "submit" ? "Затвори" : "Подай за преглед"}
                      </button>
                    )}
                    {canReview && (
                      <button className="small-btn" onClick={() => toggleExpanded(t.id, "review")}>
                        {isExpanded && expanded?.mode === "review" ? "Затвори" : "Прегледай"}
                      </button>
                    )}
                    {isAdmin && (
                      <button className="small-btn" onClick={() => toggleExpanded(t.id, "edit")}>
                        {isExpanded && expanded?.mode === "edit" ? "Затвори" : "Редактирай"}
                      </button>
                    )}
                    {isAdmin && (
                      <button className="small-btn" onClick={() => deleteTask(t)}>
                        Изтрий
                      </button>
                    )}
                  </td>
                </tr>
                {isExpanded && expanded?.mode === "submit" && (
                  <tr>
                    <td colSpan={8}>
                      <SubmitForm
                        taskId={t.id}
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
                        taskId={t.id}
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
                        task={t}
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
                {tab === "completed" ? "Няма завършени задачи." : "Няма активни задачи."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function SubmitForm({ taskId, onDone }: { taskId: string; onDone: () => void }) {
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
      setError(err instanceof Error ? err.message : "Грешка");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <label>
        Описание / обяснение на свършеното
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Какво направи, къде е резултатът…" />
      </label>
      <label>
        Прикачи скрийншоти / снимки (по избор, до 5 файла)
        <input type="file" accept="image/*,application/pdf" multiple onChange={(e) => setFiles(e.target.files)} />
      </label>
      {error && <div className="error-text">{error}</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Изпращане…" : "Подай за преглед"}
      </button>
    </form>
  );
}

function ReviewPanel({ taskId, onDone }: { taskId: string; onDone: () => void }) {
  const [task, setTask] = useState<Task | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<Task>(`/tasks/${taskId}`).then(setTask);
  }, [taskId]);

  if (!task) return <p className="muted">Зареждане…</p>;

  const submission: TaskSubmission | undefined = task.submissions?.find((s) => s.reviewStatus === "PENDING");
  if (!submission) return <p className="muted">Няма чакащо подаване.</p>;

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
      setError(err instanceof Error ? err.message : "Грешка");
    } finally {
      setSubmitting(false);
    }
  }

  async function reject() {
    if (!reviewNote.trim()) {
      setError("Обясни защо не одобряваш работата.");
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
      setError(err instanceof Error ? err.message : "Грешка");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <p>
        <strong>{submission.submittedBy.name}</strong> подаде на {new Date(submission.createdAt).toLocaleString("bg-BG")}
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
        Бележка при преглед (задължителна при отхвърляне)
        <textarea value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} rows={2} />
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="button" onClick={approve} disabled={submitting}>
          Одобри
        </button>
        <button type="button" className="secondary" onClick={reject} disabled={submitting}>
          Отхвърли
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
  const isEdit = Boolean(task);
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [assigneeId, setAssigneeId] = useState(task?.assigneeId ?? employees[0]?.id ?? "");
  const [ownerId, setOwnerId] = useState(task?.ownerId ?? "");
  const [deadline, setDeadline] = useState(task ? toLocalInputValue(task.deadline) : "");
  const [priority, setPriority] = useState<Priority>(task?.priority ?? "MEDIUM");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const employeeOptions = employees.filter((e) => e.active || e.id === assigneeId || e.id === ownerId);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!assigneeId) {
      setError("Избери служител.");
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
      setError(err instanceof Error ? err.message : "Грешка");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <label>
        Заглавие
        <input value={title} onChange={(e) => setTitle(e.target.value)} required />
      </label>
      <label>
        Описание
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </label>
      <div className="form-row">
        <label>
          Служител
          <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} required>
            <option value="" disabled>
              Избери…
            </option>
            {employeeOptions.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Owner (проверява изпълнението)
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Без — admin преглежда</option>
            {employeeOptions.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Срок
          <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} required />
        </label>
        <label>
          Приоритет
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as Priority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? "Записване…" : isEdit ? "Запази промените" : "Създай задача"}
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Отказ
          </button>
        )}
      </div>
    </form>
  );
}
