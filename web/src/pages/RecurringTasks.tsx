import { Fragment, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import { FREQUENCY_LABELS, PRIORITY_LABELS, WEEKDAY_LABELS, WEEKDAYS } from "../api/types";
import type { Priority, RecurringFrequency, RecurringTaskTemplate, User, Weekday } from "../api/types";
import { Avatar } from "../components/Avatar";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";

function formatRecurrence(tpl: RecurringTaskTemplate, t: (text: string, params?: Record<string, string | number>) => string) {
  if (tpl.frequency === "MONTHLY") {
    return t("Месечно на {day}-во число", { day: tpl.dayOfMonth ?? 1 });
  }
  return tpl.daysOfWeek
    .split(",")
    .filter(Boolean)
    .map((d) => t(WEEKDAY_LABELS[d as Weekday]))
    .join(", ");
}

// Same rule as the server's canManage(): an Admin manages everything, and a
// fully self-service template (you created it and you're the assignee) is
// yours to manage too — anything else (a Lead created it for you, or you
// created it for a scope employee) is Admin-only from here on.
function canManage(tpl: RecurringTaskTemplate, userId: string | undefined, isAdmin: boolean) {
  return isAdmin || (Boolean(userId) && tpl.createdById === userId && tpl.assigneeId === userId);
}

export function RecurringTasks() {
  const { user } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === "ADMIN";
  const [templates, setTemplates] = useState<RecurringTaskTemplate[]>([]);
  const [employees, setEmployees] = useState<User[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
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

  async function deleteTemplate(tpl: RecurringTaskTemplate) {
    if (
      !window.confirm(
        t('Наистина ли да изтрия шаблона "{title}"? Вече създадените задачи от него остават непроменени.', { title: tpl.title })
      )
    )
      return;
    await api(`/task-templates/${tpl.id}`, { method: "DELETE" });
    refresh();
  }

  if (loading) return <p>{t("Зареждане…")}</p>;

  return (
    <div>
      <div className="page-header">
        <h1>{t("Повтарящи се задачи")}</h1>
        <button
          onClick={() => {
            setShowForm((s) => !s);
            setEditingId(null);
          }}
        >
          {showForm ? t("Затвори") : t("+ Нов шаблон")}
        </button>
      </div>
      <p className="muted">
        {t(
          "Шаблон без крайна дата — седмично на избрани дни или месечно на избрано число, в избрания час, системата автоматично създава нова задача (с оригиналните напомняния, срокове и глоби). Деактивирай шаблон, за да спреш генерирането."
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
            <th>{t("Повторение")}</th>
            <th>{t("Час")}</th>
            <th>{t("Приоритет")}</th>
            <th>{t("Активен")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {templates.map((tpl) => (
            <Fragment key={tpl.id}>
              <tr>
                <td data-label={t("Заглавие")}>{tpl.title}</td>
                <td className="person-cell" data-label={t("Служител")}>
                  <div className="person-cell-group">
                    <Avatar id={tpl.assignee.id} name={tpl.assignee.name} size={22} />
                    {tpl.assignee.name}
                  </div>
                </td>
                <td data-label="Owner">{tpl.owner?.name ?? "—"}</td>
                <td data-label={t("Повторение")}>{formatRecurrence(tpl, t)}</td>
                <td data-label={t("Час")}>{tpl.timeOfDay}</td>
                <td data-label={t("Приоритет")}>{t(PRIORITY_LABELS[tpl.priority])}</td>
                <td data-label={t("Активен")}>
                  <span className={tpl.active ? "badge badge-success" : "badge"}>{tpl.active ? t("Да") : t("Не")}</span>
                </td>
                <td className="row-actions">
                  <div className="row-actions-group">
                    {canManage(tpl, user?.id, isAdmin) && (
                      <>
                        <button
                          className="small-btn"
                          onClick={() => {
                            setEditingId(editingId === tpl.id ? null : tpl.id);
                            setShowForm(false);
                          }}
                        >
                          {editingId === tpl.id ? t("Затвори") : t("Редактирай")}
                        </button>
                        <button className="small-btn" onClick={() => toggleActive(tpl)}>
                          {tpl.active ? t("Спри") : t("Активирай")}
                        </button>
                        <button className="small-btn" onClick={() => deleteTemplate(tpl)}>
                          {t("Изтрий")}
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
              {editingId === tpl.id && (
                <tr>
                  <td colSpan={8}>
                    <TemplateForm
                      template={tpl}
                      employees={employees}
                      onSaved={() => {
                        setEditingId(null);
                        refresh();
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
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

function TemplateForm({
  template,
  employees,
  onSaved,
  onCancel,
}: {
  template?: RecurringTaskTemplate;
  employees: User[];
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const { user } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === "ADMIN";
  const isLead = Boolean(user?.canAssignTasks);
  const isEdit = Boolean(template);
  const [title, setTitle] = useState(template?.title ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [assigneeId, setAssigneeId] = useState(
    template?.assigneeId ?? (isAdmin ? employees[0]?.id ?? "" : user?.id ?? "")
  );
  const [ownerId, setOwnerId] = useState(template?.ownerId ?? "");
  const [priority, setPriority] = useState<Priority>(template?.priority ?? "MEDIUM");
  const [frequency, setFrequency] = useState<RecurringFrequency>(template?.frequency ?? "WEEKLY");
  const [days, setDays] = useState<Weekday[]>((template?.daysOfWeek.split(",").filter(Boolean) as Weekday[]) ?? []);
  const [dayOfMonth, setDayOfMonth] = useState<number>(template?.dayOfMonth ?? 1);
  const [timeOfDay, setTimeOfDay] = useState(template?.timeOfDay ?? "17:00");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isSelfAssign = !isEdit && assigneeId === user?.id;

  // Mirrors TaskForm: a non-admin's `employees` list is server-scoped to
  // {self, every Admin, their own Lead scope, other Leads} — Admins in that
  // list are excluded from the assignee options unless the Ultimate Admin
  // explicitly put them in this Lead's scope.
  const [ownScope, setOwnScope] = useState<string[]>([]);
  useEffect(() => {
    if (!isAdmin && isLead && user?.id) {
      api<string[]>(`/users/${user.id}/scope`).then(setOwnScope).catch(() => {});
    }
  }, [isAdmin, isLead, user?.id]);

  const assigneeOptions = useMemo(
    () =>
      isAdmin
        ? employees.filter((e) => e.active || e.id === assigneeId || e.id === ownerId)
        : employees.filter((e) => e.id === user?.id || e.role !== "ADMIN" || ownScope.includes(e.id)),
    [employees, assigneeId, ownerId, isAdmin, user?.id, ownScope]
  );
  const ownerOptions = useMemo(() => {
    const base = isAdmin
      ? employees.filter((e) => e.active || e.id === ownerId)
      : isSelfAssign
        ? employees.filter((e) => e.role === "ADMIN")
        : employees;
    return base.filter((e) => e.id !== assigneeId);
  }, [employees, assigneeId, ownerId, isAdmin, isSelfAssign]);

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
    if (frequency === "WEEKLY" && days.length === 0) {
      setError(t("Избери поне един ден от седмицата."));
      return;
    }
    if (frequency === "MONTHLY" && (!dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31)) {
      setError(t("Избери ден от месеца (1–31)."));
      return;
    }
    if (isSelfAssign && !ownerId) {
      setError(t("Самозададен шаблон трябва да има Owner — администратор, който да следи изпълнението."));
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        title,
        description: description || undefined,
        assigneeId,
        ownerId: ownerId || null,
        priority,
        frequency,
        daysOfWeek: frequency === "WEEKLY" ? days : [],
        dayOfMonth: frequency === "MONTHLY" ? dayOfMonth : undefined,
        timeOfDay,
      };
      if (isEdit) {
        await api(`/task-templates/${template!.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api("/task-templates", { method: "POST", body: JSON.stringify({ ...body, ownerId: ownerId || undefined }) });
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
          {!isEdit && !isAdmin && !isLead ? (
            <input value={user?.name ?? ""} disabled />
          ) : (
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} required disabled={isEdit && !isAdmin}>
              <option value="" disabled>
                {t("Избери…")}
              </option>
              {assigneeOptions.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.id === user?.id ? t("Ти") : emp.name}
                </option>
              ))}
            </select>
          )}
        </label>
        <label>
          {t("Owner (проверява всеки цикъл)")}
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} required={isSelfAssign}>
            {!isSelfAssign && <option value="">{t("Без — admin преглежда")}</option>}
            {isSelfAssign && (
              <option value="" disabled>
                {t("Избери администратор…")}
              </option>
            )}
            {ownerOptions.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.name}
              </option>
            ))}
          </select>
          {isSelfAssign && (
            <span className="muted small">{t("Самозададен шаблон изисква администратор, който да следи изпълнението.")}</span>
          )}
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
          {t("Честота")}
          <select value={frequency} onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}>
            {(["WEEKLY", "MONTHLY"] as RecurringFrequency[]).map((f) => (
              <option key={f} value={f}>
                {t(FREQUENCY_LABELS[f])}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Час на срока")}
          <input type="time" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} required />
        </label>
      </div>
      {frequency === "WEEKLY" ? (
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
      ) : (
        <label>
          {t("Ден от месеца")}
          <input
            type="number"
            min={1}
            max={31}
            value={dayOfMonth}
            onChange={(e) => setDayOfMonth(Number(e.target.value))}
            required
          />
          <span className="muted small">
            {t("Ако месецът е по-кратък (напр. февруари), задачата ще се създава на последния му ден.")}
          </span>
        </label>
      )}
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? t("Записване…") : isEdit ? t("Запази промените") : t("Създай шаблон")}
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
