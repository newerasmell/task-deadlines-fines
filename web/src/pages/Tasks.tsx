import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import { PRIORITY_LABELS, STATUS_LABELS } from "../api/types";
import type { Priority, Task, User } from "../api/types";
import { useAuth } from "../context/AuthContext";

const statusBadgeClass: Record<Task["status"], string> = {
  PENDING: "badge",
  IN_PROGRESS: "badge badge-info",
  DONE: "badge badge-success",
  OVERDUE: "badge badge-danger",
  CANCELLED: "badge",
};

export function Tasks() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const [tasks, setTasks] = useState<Task[]>([]);
  const [employees, setEmployees] = useState<User[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);

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

  async function markDone(id: string) {
    await api(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status: "DONE" }) });
    refresh();
  }

  if (loading) return <p>Зареждане…</p>;

  return (
    <div>
      <div className="page-header">
        <h1>Задачи</h1>
        {isAdmin && (
          <button onClick={() => setShowForm((s) => !s)}>{showForm ? "Затвори" : "+ Нова задача"}</button>
        )}
      </div>

      {isAdmin && showForm && (
        <NewTaskForm
          employees={employees}
          onCreated={() => {
            setShowForm(false);
            refresh();
          }}
        />
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Задача</th>
            <th>Служител</th>
            <th>Срок</th>
            <th>Приоритет</th>
            <th>Статус</th>
            <th>Глоби</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => {
            const activeFines = (t.fines ?? []).filter((f) => f.status === "ACTIVE");
            const fineTotal = activeFines.reduce((s, f) => s + f.amount, 0);
            return (
              <tr key={t.id}>
                <td>
                  <div>{t.title}</div>
                  {t.description && <div className="muted small">{t.description}</div>}
                </td>
                <td>{t.assignee.name}</td>
                <td>{new Date(t.deadline).toLocaleString("bg-BG")}</td>
                <td>{PRIORITY_LABELS[t.priority]}</td>
                <td>
                  <span className={statusBadgeClass[t.status]}>{STATUS_LABELS[t.status]}</span>
                </td>
                <td>{fineTotal > 0 ? `${fineTotal.toFixed(2)} ${activeFines[0].currency}` : "—"}</td>
                <td>
                  {t.status !== "DONE" && t.status !== "CANCELLED" && (
                    <button className="small-btn" onClick={() => markDone(t.id)}>
                      Маркирай завършена
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {tasks.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                Няма задачи.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function NewTaskForm({ employees, onCreated }: { employees: User[]; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState(employees[0]?.id ?? "");
  const [deadline, setDeadline] = useState("");
  const [priority, setPriority] = useState<Priority>("MEDIUM");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const employeeOptions = employees.filter((e) => e.active);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!assigneeId) {
      setError("Избери служител.");
      return;
    }
    setSubmitting(true);
    try {
      await api("/tasks", {
        method: "POST",
        body: JSON.stringify({
          title,
          description: description || undefined,
          assigneeId,
          deadline: new Date(deadline).toISOString(),
          priority,
        }),
      });
      onCreated();
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
      <button type="submit" disabled={submitting}>
        {submitting ? "Създаване…" : "Създай задача"}
      </button>
    </form>
  );
}
