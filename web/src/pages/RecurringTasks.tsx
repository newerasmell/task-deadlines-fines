import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import { PRIORITY_LABELS, WEEKDAY_LABELS, WEEKDAYS } from "../api/types";
import type { Priority, RecurringTaskTemplate, User, Weekday } from "../api/types";
import { Avatar } from "../components/Avatar";
import { useI18n } from "../i18n/I18nContext";

export function RecurringTasks() {
  const { t } = useI18n();
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

  async function toggleActive(tpl: RecurringTaskTemplate) {
    await api(`/task-templates/${tpl.id}`, { method: "PATCH", body: JSON.stringify({ active: !tpl.active }) });
    refresh();
  }

  if (loading) return <p>{t("Зареждане…")}</p>;

  return (
    <div>
      <div className="page-header">
        <h1>{t("Повтарящи се задачи")}</h1>
        <button onClick={() => setShowForm((s) => !s)}>{showForm ? t("Затвори") : t("+ Нов шаблон")}</button>
      </div>
      <p className="muted">
        {t(
          "Шаблон без крайна дата — на всеки избран ден от седмицата, в избрания час, системата автоматично създава нова задача (с оригиналните напомняния, срокове и глоби). Деактивирай шаблон, за да спреш генерирането."
        )}
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

      <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t("Заглавие")}</th>
            <th>{t("Служител")}</th>
            <th>Owner</th>
            <th>{t("Дни")}</th>
            <th>{t("Час")}</th>
            <th>{t("Приоритет")}</th>
            <th>{t("Активен")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {templates.map((tpl) => (
            <tr key={tpl.id}>
              <td data-label={t("Заглавие")}>{tpl.title}</td>
              <td className="person-cell" data-label={t("Служител")}>
                <Avatar id={tpl.assignee.id} name={tpl.assignee.name} size={22} />
                {tpl.assignee.name}
              </td>
              <td data-label="Owner">{tpl.owner?.name ?? "—"}</td>
              <td data-label={t("Дни")}>{tpl.daysOfWeek.split(",").map((d) => t(WEEKDAY_LABELS[d as Weekday])).join(", ")}</td>
              <td data-label={t("Час")}>{tpl.timeOfDay}</td>
              <td data-label={t("Приоритет")}>{t(PRIORITY_LABELS[tpl.priority])}</td>
              <td data-label={t("Активен")}>
                <span className={tpl.active ? "badge badge-success" : "badge"}>{tpl.active ? t("Да") : t("Не")}</span>
              </td>
              <td className="row-actions">
                <button className="small-btn" onClick={() => toggleActive(tpl)}>
                  {tpl.active ? t("Спри") : t("Активирай")}
                </button>
              </td>
            </tr>
          ))}
          {templates.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                {t("Няма повтарящи се задачи.")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function TemplateForm({ employees, onSaved }: { employees: User[]; onSaved: () => void }) {
  const { t } = useI18n();
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
      setError(t("Избери служител."));
      return;
    }
    if (days.length === 0) {
      setError(t("Избери поне един ден от седмицата."));
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
          {t("Owner (проверява всеки цикъл)")}
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
          {t("Приоритет")}
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as Priority[]).map((p) => (
              <option key={p} value={p}>
                {t(PRIORITY_LABELS[p])}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Час на срока")}
          <input type="time" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} required />
        </label>
      </div>
      <label>
        {t("Дни от седмицата")}
        <div className="weekday-picker">
          {WEEKDAYS.map((day) => (
            <label key={day}>
              <input type="checkbox" checked={days.includes(day)} onChange={() => toggleDay(day)} />
              {t(WEEKDAY_LABELS[day])}
            </label>
          ))}
        </div>
      </label>
      {error && <div className="error-text">{error}</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? t("Създаване…") : t("Създай шаблон")}
      </button>
    </form>
  );
}
