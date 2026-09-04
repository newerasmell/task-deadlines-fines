import { Fragment, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import type { Subscription, SubscriptionStatus, User } from "../api/types";
import { SUBSCRIPTION_STATUS_LABELS } from "../api/types";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";

const CATEGORY_PRESETS = ["domain", "phone", "virtual_phone", "subscription", "other"] as const;

const CATEGORY_LABELS: Record<string, string> = {
  domain: "Домейн",
  phone: "Телефонен номер",
  virtual_phone: "Виртуален номер",
  subscription: "Абонамент",
  other: "Друго",
};

function daysUntil(dueDate: string): number {
  return Math.ceil((new Date(dueDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function urgencyClass(days: number): string {
  if (days < 0) return "badge badge-danger";
  if (days <= 7) return "badge badge-danger";
  if (days <= 30) return "badge badge-warning";
  return "badge";
}

export function Subscriptions() {
  const { t, lang } = useI18n();
  const locale = lang === "en" ? "en-GB" : "bg-BG";
  const [items, setItems] = useState<Subscription[]>([]);
  const [employees, setEmployees] = useState<User[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Subscription | null>(null);
  const [tab, setTab] = useState<"active" | "all">("active");
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setItems(await api<Subscription[]>("/subscriptions"));
  }

  useEffect(() => {
    Promise.all([refresh(), api<User[]>("/users").then((all) => setEmployees(all.filter((e) => e.active)))]).finally(() =>
      setLoading(false)
    );
  }, []);

  async function markPaid(item: Subscription) {
    await api(`/subscriptions/${item.id}`, { method: "PATCH", body: JSON.stringify({ status: "PAID" }) });
    refresh();
  }

  async function deleteItem(item: Subscription) {
    if (!window.confirm(t('Наистина ли да изтрия "{title}"?', { title: item.title }))) return;
    await api(`/subscriptions/${item.id}`, { method: "DELETE" });
    refresh();
  }

  if (loading) return <p>{t("Зареждане…")}</p>;

  const visible = items.filter((it) => (tab === "active" ? it.status === "ACTIVE" : true));

  return (
    <div>
      <div className="page-header">
        <h1>{t("Абонаменти")}</h1>
        <button
          onClick={() => {
            setShowForm((s) => !s);
            setEditing(null);
          }}
        >
          {showForm ? t("Затвори") : t("+ Нов елемент")}
        </button>
      </div>
      <p className="muted">
        {t(
          "Следи изтичащи домейни, телефонни номера, виртуални номера и други периодични плащания. Без глоби — само напомняния: 1 месец, 15 дни и 7 дни преди падежа, всеки ден оттам насетне, и на всеки 2 часа в самия ден."
        )}
      </p>

      {showForm && (
        <SubscriptionForm
          employees={employees}
          onSaved={() => {
            setShowForm(false);
            refresh();
          }}
        />
      )}

      <div className="tabs">
        <button className={tab === "active" ? "active" : ""} onClick={() => setTab("active")}>
          {t("Активни")}
        </button>
        <button className={tab === "all" ? "active" : ""} onClick={() => setTab("all")}>
          {t("Всички")}
        </button>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t("Заглавие")}</th>
              <th>{t("Категория")}</th>
              <th>{t("Краен срок")}</th>
              <th>{t("Остават")}</th>
              <th>{t("Сума")}</th>
              <th>{t("Служител")}</th>
              <th>Owner</th>
              <th>{t("Статус")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((it) => {
              const days = daysUntil(it.dueDate);
              const isEditing = editing?.id === it.id;
              return (
                <Fragment key={it.id}>
                  <tr>
                    <td data-label={t("Заглавие")}>
                      {it.title}
                      {it.description && <div className="muted small">{it.description}</div>}
                    </td>
                    <td data-label={t("Категория")}>{it.category ? t(CATEGORY_LABELS[it.category] ?? it.category) : "—"}</td>
                    <td data-label={t("Краен срок")}>{new Date(it.dueDate).toLocaleString(locale)}</td>
                    <td data-label={t("Остават")}>
                      {it.status === "ACTIVE" ? (
                        <span className={urgencyClass(days)}>
                          {days < 0
                            ? t("просрочено с {days} дни", { days: Math.abs(days) })
                            : t("{days} дни", { days })}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td data-label={t("Сума")}>{it.amount ? `${it.amount.toFixed(2)} ${it.currency ?? "EUR"}` : "—"}</td>
                    <td data-label={t("Служител")}>{it.assignee.name}</td>
                    <td data-label="Owner">{it.owner?.name ?? "—"}</td>
                    <td data-label={t("Статус")}>
                      <span className={it.status === "ACTIVE" ? "badge" : "badge badge-success"}>
                        {t(SUBSCRIPTION_STATUS_LABELS[it.status])}
                      </span>
                    </td>
                    <td className="row-actions">
                      <div className="row-actions-group">
                        {it.status === "ACTIVE" && (
                          <button className="small-btn" onClick={() => markPaid(it)}>
                            {t("Платено")}
                          </button>
                        )}
                        <button
                          className="small-btn"
                          onClick={() => {
                            setEditing(isEditing ? null : it);
                            setShowForm(false);
                          }}
                        >
                          {isEditing ? t("Затвори") : t("Редактирай")}
                        </button>
                        <button className="small-btn" onClick={() => deleteItem(it)}>
                          {t("Изтрий")}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isEditing && (
                    <tr>
                      <td colSpan={9}>
                        <SubscriptionForm
                          item={it}
                          employees={employees}
                          onSaved={() => {
                            setEditing(null);
                            refresh();
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  {tab === "active" ? t("Няма активни елементи.") : t("Няма елементи.")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SubscriptionForm({
  item,
  employees,
  onSaved,
  onCancel,
}: {
  item?: Subscription;
  employees: User[];
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const { user } = useAuth();
  const { t } = useI18n();
  const isEdit = Boolean(item);
  const [title, setTitle] = useState(item?.title ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [category, setCategory] = useState(item?.category ?? "domain");
  const [dueDate, setDueDate] = useState(item ? item.dueDate.slice(0, 16) : "");
  const [amount, setAmount] = useState(item?.amount != null ? String(item.amount) : "");
  const [currency, setCurrency] = useState(item?.currency ?? "EUR");
  const [assigneeId, setAssigneeId] = useState(item?.assigneeId ?? user?.id ?? "");
  const [ownerId, setOwnerId] = useState(item?.ownerId ?? "");
  const [status, setStatus] = useState<SubscriptionStatus>(item?.status ?? "ACTIVE");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!dueDate) {
      setError(t("Избери краен срок."));
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        title,
        description: description || undefined,
        category: category || undefined,
        dueDate,
        amount: amount ? Number(amount) : undefined,
        currency: currency || undefined,
        assigneeId: assigneeId || undefined,
        ownerId: ownerId || undefined,
      };
      if (isEdit && item) {
        await api(`/subscriptions/${item.id}`, { method: "PATCH", body: JSON.stringify({ ...body, status }) });
      } else {
        await api("/subscriptions", { method: "POST", body: JSON.stringify(body) });
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
      <div className="form-row">
        <label>
          {t("Заглавие")}
          <input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label>
          {t("Категория")}
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORY_PRESETS.map((c) => (
              <option key={c} value={c}>
                {t(CATEGORY_LABELS[c])}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Краен срок за плащане")}
          <input type="datetime-local" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
        </label>
      </div>
      <div className="form-row">
        <label>
          {t("Сума")}
          <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label>
          {t("Валута")}
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={8} />
        </label>
        <label>
          {t("Служител")}
          <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} required>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.id === user?.id ? t("Ти") : emp.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Owner
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">{t("Без — само служителят")}</option>
            {employees.map((emp) => (
              <option key={emp.id} value={emp.id}>
                {emp.id === user?.id ? t("Ти") : emp.name}
              </option>
            ))}
          </select>
        </label>
        {isEdit && (
          <label>
            {t("Статус")}
            <select value={status} onChange={(e) => setStatus(e.target.value as SubscriptionStatus)}>
              <option value="ACTIVE">{t("Активен")}</option>
              <option value="PAID">{t("Платен/подновен")}</option>
              <option value="CANCELLED">{t("Отменен")}</option>
            </select>
          </label>
        )}
      </div>
      <label>
        {t("Бележка")}
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? t("Записване…") : isEdit ? t("Запази промените") : t("Създай")}
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
