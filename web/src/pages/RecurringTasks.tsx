import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import { PRIORITY_LABELS, WEEKDAY_LABELS, WEEKDAYS } from "../api/types";
import type { Priority, RecurringTaskTemplate, User, Weekday } from "../api/types";

export function RecurringTasks() {
  const [templates, setTemplates] = useState<RecurringTaskTemplate[]>([]);
  const [employees, setEmployees] = useState<User[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setTemplates(await api<RecurringTaskTemplate[]>("/task-templates"));
  }

  useEffect(() => {
    Promise.all([refresh(), api<User[]>("/users").then(setEmployees)]).finally(() => setLoading(false));
  }, []);

  async function toggleActive(t: RecurringTaskTemplate) {
    await api(`/task-templates/${t.id}`, { method: "PATCH", body: JSON.stringify({ active: !t.active }) });
    refresh();
  }

  if (loading) return <p>Зареждане…</p>;

  return (
    <div>
      <div className="page-header">
        <h1>Повтарящи се задачи</h1>
        <button onClick={() => setShowForm((s) => !s)}>{showForm ? "Затвори" : "+ Нов шаблон"}</button>
      </div>
      <p className="muted">
        Шаблон без крайна дата — на всеки избран ден от седмицата, в избрания час, системата автоматично създава
        нова задача (с оригиналните напомняния, срокове и глоби). Деактивирай шаблон, за да спреш генерирането.
      </p>

      {showForm && (
        <TemplateForm
          employees={employees}
          onSaved={() => {
            setShowForm(false);
            refresh();
          }}
        />
      )}

      <table className="table">
        <thead>
          <tr>
            <th>Заглавие</th>
            <th>Служител</th>
            <th>Owner</th>
            <th>Дни</th>
            <th>Час</th>
            <th>Приоритет</th>
            <th>Активен</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {templates.map((t) => (
            <tr key={t.id}>
              <td>{t.title}</td>
              <td>{t.assignee.name}</td>
              <td>{t.owner?.name ?? "—"}</td>
              <td>{t.daysOfWeek.split(",").map((d) => WEEKDAY_LABELS[d as Weekday]).join(", ")}</td>
              <td>{t.timeOfDay}</td>
              <td>{PRIORITY_LABELS[t.priority]}</td>
              <td>
                <span className={t.active ? "badge badge-success" : "badge"}>{t.active ? "Да" : "Не"}</span>
              </td>
              <td>
                <button className="small-btn" onClick={() => toggleActive(t)}>
                  {t.active ? "Спри" : "Активирай"}
                </button>
              </td>
            </tr>
          ))}
          {templates.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                Няма повтарящи се задачи.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function TemplateForm({ employees, onSaved }: { employees: User[]; onSaved: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState(employees[0]?.id ?? "");
  const [ownerId, setOwnerId] = useState("");
  const [priority, setPriority] = useState<Priority>("MEDIUM");
  const [days, setDays] = useState<Weekday[]>([]);
  const [timeOfDay, setTimeOfDay] = useState("17:00");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const employeeOptions = employees.filter((e) => e.active);

  function toggleDay(day: Weekday) {
    setDays((cur) => (cur.includes(day) ? cur.filter((d) => d !== day) : [...cur, day]));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!assigneeId) {
      setError("Избери служител.");
      return;
    }
    if (days.length === 0) {
      setError("Избери поне един ден от седмицата.");
      return;
    }
    setSubmitting(true);
    try {
      await api("/task-templates", {
        method: "POST",
        body: JSON.stringify({
          title,
          description: description || undefined,
          assigneeId,
          ownerId: ownerId || undefined,
          priority,
          daysOfWeek: days,
          timeOfDay,
        }),
      });
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
          Owner (проверява всеки цикъл)
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
          Приоритет
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as Priority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Час на срока
          <input type="time" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} required />
        </label>
      </div>
      <label>
        Дни от седмицата
        <div className="weekday-picker">
          {WEEKDAYS.map((day) => (
            <label key={day}>
              <input type="checkbox" checked={days.includes(day)} onChange={() => toggleDay(day)} />
              {WEEKDAY_LABELS[day]}
            </label>
          ))}
        </div>
      </label>
      {error && <div className="error-text">{error}</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Създаване…" : "Създай шаблон"}
      </button>
    </form>
  );
}
