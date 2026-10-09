import { Fragment, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import type { CompanyDeadline, CompanyDeadlineRecurrence, CompanyDeadlineStatus } from "../api/types";
import { COMPANY_DEADLINE_RECURRENCE_LABELS, COMPANY_DEADLINE_STATUS_LABELS } from "../api/types";
import { useI18n } from "../i18n/I18nContext";

function daysUntil(dueDate: string): number {
  return Math.ceil((new Date(dueDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function urgencyClass(days: number): string {
  if (days < 0) return "badge badge-danger";
  if (days <= 7) return "badge badge-danger";
  if (days <= 30) return "badge badge-warning";
  return "badge";
}

export function CompanyDeadlines() {
  const { t, lang } = useI18n();
  const locale = lang === "en" ? "en-GB" : "bg-BG";
  const [items, setItems] = useState<CompanyDeadline[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CompanyDeadline | null>(null);
  const [tab, setTab] = useState<"active" | "all">("active");
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setItems(await api<CompanyDeadline[]>("/company-deadlines"));
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  async function markDone(item: CompanyDeadline) {
    await api(`/company-deadlines/${item.id}`, { method: "PATCH", body: JSON.stringify({ status: "DONE" }) });
    refresh();
  }

  async function deleteItem(item: CompanyDeadline) {
    if (!window.confirm(t('Наистина ли да изтрия "{title}"?', { title: item.title }))) return;
    await api(`/company-deadlines/${item.id}`, { method: "DELETE" });
    refresh();
  }

  if (loading) return <p>{t("Зареждане…")}</p>;

  const visible = items.filter((it) => (tab === "active" ? it.status === "ACTIVE" : true));

  return (
    <div>
      <div className="page-header">
        <h1>{t("Фирмени дедлайни")}</h1>
        <button
          onClick={() => {
            setShowForm((s) => !s);
            setEditing(null);
          }}
        >
          {showForm ? t("Затвори") : t("+ Нов срок")}
        </button>
      </div>
      <p className="muted">
        {t(
          "Следи счетоводни и юридически срокове за всички компании в групата — подаване на документи, подновяване на стейтменти и други изисквания по юрисдикции. Нотификациите отиват само до мастър акаунтите (Ultimate Admin). Напомняния: 1 месец, 15 дни и 7 дни преди падежа, всеки ден оттам насетне, и на всеки 2 часа в самия ден."
        )}
      </p>

      {showForm && (
        <CompanyDeadlineForm
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
              <th>{t("Компания")}</th>
              <th>{t("Юрисдикция")}</th>
              <th>{t("Заглавие")}</th>
              <th>{t("Краен срок")}</th>
              <th>{t("Остават")}</th>
              <th>{t("Повторение")}</th>
              <th>{t("Сума")}</th>
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
                    <td data-label={t("Компания")}>
                      <strong>{it.company}</strong>
                    </td>
                    <td data-label={t("Юрисдикция")}>{it.jurisdiction}</td>
                    <td data-label={t("Заглавие")}>
                      {it.title}
                      {it.description && <div className="muted small">{it.description}</div>}
                    </td>
                    <td data-label={t("Краен срок")}>{new Date(it.dueDate).toLocaleString(locale)}</td>
                    <td data-label={t("Остават")}>
                      {it.status === "ACTIVE" ? (
                        <span className={urgencyClass(days)}>
                          {days < 0 ? t("просрочено с {days} дни", { days: Math.abs(days) }) : t("{days} дни", { days })}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td data-label={t("Повторение")}>
                      {it.recurrence === "NONE" ? (
                        <span className="muted">{t(COMPANY_DEADLINE_RECURRENCE_LABELS[it.recurrence])}</span>
                      ) : (
                        <span className="badge badge-info">↻ {t(COMPANY_DEADLINE_RECURRENCE_LABELS[it.recurrence])}</span>
                      )}
                    </td>
                    <td data-label={t("Сума")}>{it.amount ? `${it.amount.toFixed(2)} ${it.currency ?? "EUR"}` : "—"}</td>
                    <td data-label={t("Статус")}>
                      <span className={it.status === "ACTIVE" ? "badge" : it.status === "DONE" ? "badge badge-success" : "badge"}>
                        {t(COMPANY_DEADLINE_STATUS_LABELS[it.status])}
                      </span>
                    </td>
                    <td className="row-actions">
                      <div className="row-actions-group">
                        {it.status === "ACTIVE" && (
                          <button className="small-btn" onClick={() => markDone(it)}>
                            {t("Изпълнен")}
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
                        <CompanyDeadlineForm
                          item={it}
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
                  {tab === "active" ? t("Няма активни срокове.") : t("Няма срокове.")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CompanyDeadlineForm({
  item,
  onSaved,
  onCancel,
}: {
  item?: CompanyDeadline;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const isEdit = Boolean(item);
  const [company, setCompany] = useState(item?.company ?? "");
  const [jurisdiction, setJurisdiction] = useState(item?.jurisdiction ?? "");
  const [title, setTitle] = useState(item?.title ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [dueDate, setDueDate] = useState(item ? item.dueDate.slice(0, 16) : "");
  const [amount, setAmount] = useState(item?.amount != null ? String(item.amount) : "");
  const [currency, setCurrency] = useState(item?.currency ?? "EUR");
  const [recurrence, setRecurrence] = useState<CompanyDeadlineRecurrence>(item?.recurrence ?? "YEARLY");
  const [status, setStatus] = useState<CompanyDeadlineStatus>(item?.status ?? "ACTIVE");
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
        company,
        jurisdiction,
        title,
        description: description || undefined,
        dueDate,
        amount: amount ? Number(amount) : undefined,
        currency: currency || undefined,
        recurrence,
      };
      if (isEdit && item) {
        await api(`/company-deadlines/${item.id}`, { method: "PATCH", body: JSON.stringify({ ...body, status }) });
      } else {
        await api("/company-deadlines", { method: "POST", body: JSON.stringify(body) });
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
          {t("Компания")}
          <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder={t("Напр. Acme Ltd")} required />
        </label>
        <label>
          {t("Юрисдикция")}
          <input
            value={jurisdiction}
            onChange={(e) => setJurisdiction(e.target.value)}
            placeholder={t("Напр. England, САЩ (Delaware), България")}
            required
          />
        </label>
      </div>
      <div className="form-row">
        <label>
          {t("Заглавие")}
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("Напр. Confirmation Statement")} required />
        </label>
        <label>
          {t("Краен срок")}
          <input type="datetime-local" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
        </label>
        <label>
          {t("Повторение")}
          <select value={recurrence} onChange={(e) => setRecurrence(e.target.value as CompanyDeadlineRecurrence)}>
            {(Object.keys(COMPANY_DEADLINE_RECURRENCE_LABELS) as CompanyDeadlineRecurrence[]).map((r) => (
              <option key={r} value={r}>
                {t(COMPANY_DEADLINE_RECURRENCE_LABELS[r])}
              </option>
            ))}
          </select>
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
        {isEdit && (
          <label>
            {t("Статус")}
            <select value={status} onChange={(e) => setStatus(e.target.value as CompanyDeadlineStatus)}>
              <option value="ACTIVE">{t("Активен")}</option>
              <option value="DONE">{t("Изпълнен")}</option>
              <option value="CANCELLED">{t("Отменен")}</option>
            </select>
          </label>
        )}
      </div>
      {recurrence !== "NONE" && (
        <p className="muted small">
          {t("При отбелязване като „Изпълнен“ автоматично се създава следващият цикъл с новия краен срок — историята остава видима.")}
        </p>
      )}
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
