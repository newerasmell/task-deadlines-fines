import { Fragment, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import { CHANNEL_LABELS, PRIORITY_LABELS } from "../api/types";
import type { ChannelStatus, FineRule, Priority } from "../api/types";
import { useI18n } from "../i18n/I18nContext";

export function Settings() {
  const { t } = useI18n();
  const [rules, setRules] = useState<FineRule[]>([]);
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const [r, c] = await Promise.all([api<FineRule[]>("/fine-rules"), api<ChannelStatus[]>("/notifications/channels")]);
    setRules(r);
    setChannels(c);
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  async function toggleActive(rule: FineRule) {
    await api(`/fine-rules/${rule.id}`, { method: "PATCH", body: JSON.stringify({ active: !rule.active }) });
    refresh();
  }

  async function deleteRule(rule: FineRule) {
    if (!window.confirm(t('Наистина ли да изтрия правилото "{name}"?', { name: rule.name }))) return;
    await api(`/fine-rules/${rule.id}`, { method: "DELETE" });
    refresh();
  }

  if (loading) return <p>{t("Зареждане…")}</p>;

  return (
    <div>
      <h1>{t("Настройки")}</h1>

      <h2>{t("Канали за известия")}</h2>
      <p className="muted">
        {t("Статусът показва дали сървърът има зададени данни за достъп (в")} <code>server/.env</code>
        {t(") за всеки канал. Виж README за стъпки как да настроиш всеки от тях.")}
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>{t("Канал")}</th>
            <th>{t("Статус")}</th>
          </tr>
        </thead>
        <tbody>
          {channels.map((c) => (
            <tr key={c.channel}>
              <td>{CHANNEL_LABELS[c.channel]}</td>
              <td>
                <span className={c.configured ? "badge badge-success" : "badge"}>
                  {c.configured ? t("Настроен") : t("Не е настроен")}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="page-header">
        <h2>{t("Правила за глоби")}</h2>
        <button
          onClick={() => {
            setShowForm((s) => !s);
            setEditingId(null);
          }}
        >
          {showForm ? t("Затвори") : t("+ Ново правило")}
        </button>
      </div>
      <p className="muted">
        {t(
          "Всяка задача се проверява спрямо правилото за нейния приоритет (или общото правило, ако няма специфично). При просрочие след периода на толеранс се начислява базова сума, плюс сума за всеки следващ ден закъснение, до максимума."
        )}
      </p>

      {showForm && (
        <RuleForm
          onSaved={() => {
            setShowForm(false);
            refresh();
          }}
        />
      )}

      <table className="table">
        <thead>
          <tr>
            <th>{t("Име")}</th>
            <th>{t("Приоритет")}</th>
            <th>{t("Толеранс (ч)")}</th>
            <th>{t("Базова сума")}</th>
            <th>{t("На ден")}</th>
            <th>{t("Максимум")}</th>
            <th>{t("Активно")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <Fragment key={r.id}>
              <tr>
                <td>{r.name}</td>
                <td>{r.priority ? t(PRIORITY_LABELS[r.priority]) : t("Всички (по подразбиране)")}</td>
                <td>{r.graceHours}</td>
                <td>
                  {r.baseAmount} {r.currency}
                </td>
                <td>
                  {r.perDayAmount} {r.currency}
                </td>
                <td>{r.maxAmount ? `${r.maxAmount} ${r.currency}` : "—"}</td>
                <td>
                  <span className={r.active ? "badge badge-success" : "badge"}>{r.active ? t("Да") : t("Не")}</span>
                </td>
                <td className="row-actions">
                  <button
                    className="small-btn"
                    onClick={() => {
                      setEditingId(editingId === r.id ? null : r.id);
                      setShowForm(false);
                    }}
                  >
                    {editingId === r.id ? t("Затвори") : t("Редактирай")}
                  </button>
                  <button className="small-btn" onClick={() => toggleActive(r)}>
                    {r.active ? t("Деактивирай") : t("Активирай")}
                  </button>
                  <button className="small-btn" onClick={() => deleteRule(r)}>
                    {t("Изтрий")}
                  </button>
                </td>
              </tr>
              {editingId === r.id && (
                <tr>
                  <td colSpan={8}>
                    <RuleForm
                      rule={r}
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
          {rules.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                {t("Няма правила.")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function RuleForm({ rule, onSaved, onCancel }: { rule?: FineRule; onSaved: () => void; onCancel?: () => void }) {
  const { t } = useI18n();
  const isEdit = Boolean(rule);
  const [name, setName] = useState(rule?.name ?? "");
  const [priority, setPriority] = useState<Priority | "">(rule?.priority ?? "");
  const [baseAmount, setBaseAmount] = useState(String(rule?.baseAmount ?? 20));
  const [perDayAmount, setPerDayAmount] = useState(String(rule?.perDayAmount ?? 10));
  const [graceHours, setGraceHours] = useState(String(rule?.graceHours ?? 2));
  const [maxAmount, setMaxAmount] = useState(rule?.maxAmount != null ? String(rule.maxAmount) : "");
  const [currency, setCurrency] = useState(rule?.currency ?? "EUR");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const body = {
        name,
        priority: priority || null,
        baseAmount: Number(baseAmount),
        perDayAmount: Number(perDayAmount),
        graceHours: Number(graceHours),
        maxAmount: maxAmount ? Number(maxAmount) : null,
        currency,
      };
      if (isEdit) {
        await api(`/fine-rules/${rule!.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api("/fine-rules", { method: "POST", body: JSON.stringify(body) });
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
          {t("Име")}
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          {t("Приоритет")}
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority | "")}>
            <option value="">{t("Всички (по подразбиране)")}</option>
            {(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as Priority[]).map((p) => (
              <option key={p} value={p}>
                {t(PRIORITY_LABELS[p])}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-row">
        <label>
          {t("Толеранс (часове)")}
          <input type="number" min="0" value={graceHours} onChange={(e) => setGraceHours(e.target.value)} />
        </label>
        <label>
          {t("Базова сума")}
          <input type="number" min="0" step="0.01" value={baseAmount} onChange={(e) => setBaseAmount(e.target.value)} />
        </label>
        <label>
          {t("Сума на ден")}
          <input type="number" min="0" step="0.01" value={perDayAmount} onChange={(e) => setPerDayAmount(e.target.value)} />
        </label>
        <label>
          {t("Максимум (по избор)")}
          <input type="number" min="0" step="0.01" value={maxAmount} onChange={(e) => setMaxAmount(e.target.value)} />
        </label>
        <label>
          {t("Валута")}
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} />
        </label>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? t("Записване…") : isEdit ? t("Запази промените") : t("Създай правило")}
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
