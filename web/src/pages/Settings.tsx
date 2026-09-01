import { Fragment, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import { CHANNEL_LABELS } from "../api/types";
import type { ChannelStatus, FineRule, User } from "../api/types";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";

export function Settings() {
  const { user } = useAuth();
  const isSuperAdmin = Boolean(user?.isSuperAdmin);
  const { t } = useI18n();
  const [rules, setRules] = useState<FineRule[]>([]);
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [employees, setEmployees] = useState<User[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const promises: [Promise<FineRule[]>, Promise<ChannelStatus[]>, Promise<User[]>?] = [
      api<FineRule[]>("/fine-rules"),
      api<ChannelStatus[]>("/notifications/channels"),
    ];
    if (isSuperAdmin) promises[2] = api<User[]>("/users");
    const [r, c, u] = await Promise.all(promises);
    setRules(r);
    setChannels(c);
    if (u) setEmployees(u);
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      <div className="table-wrap">
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
              <td data-label={t("Канал")}>{CHANNEL_LABELS[c.channel]}</td>
              <td data-label={t("Статус")}>
                <span className={c.configured ? "badge badge-success" : "badge"}>
                  {c.configured ? t("Настроен") : t("Не е настроен")}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <div className="page-header">
        <h2>{t("Правила за глоби")}</h2>
        {isSuperAdmin && (
          <button
            onClick={() => {
              setShowForm((s) => !s);
              setEditingId(null);
            }}
          >
            {showForm ? t("Затвори") : t("+ Ново правило")}
          </button>
        )}
      </div>
      <p className="muted">
        {t(
          "Правилата не зависят от приоритета на задачата — само Ultimate Admin решава кой акаунт по кое правило се глобява. Правило без зададени акаунти е общото правило за всички останали. При просрочие след периода на толеранс се начислява базова сума, плюс сума за всеки следващ ден закъснение, до максимума."
        )}
      </p>

      {isSuperAdmin && showForm && (
        <RuleForm
          allEmployees={employees}
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
            <th>{t("Име")}</th>
            <th>{t("Служители")}</th>
            <th>{t("Толеранс (ч)")}</th>
            <th>{t("Базова сума")}</th>
            <th>{t("На ден")}</th>
            <th>{t("Максимум")}</th>
            <th>{t("Активно")}</th>
            {isSuperAdmin && <th></th>}
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <Fragment key={r.id}>
              <tr>
                <td data-label={t("Име")}>{r.name}</td>
                <td data-label={t("Служители")}>
                  {r.assignedUsers.length === 0
                    ? t("Всички (по подразбиране)")
                    : r.assignedUsers.map((a) => a.user.name).join(", ")}
                </td>
                <td data-label={t("Толеранс (ч)")}>{r.graceHours}</td>
                <td data-label={t("Базова сума")}>
                  {r.baseAmount} {r.currency}
                </td>
                <td data-label={t("На ден")}>
                  {r.perDayAmount} {r.currency}
                </td>
                <td data-label={t("Максимум")}>{r.maxAmount ? `${r.maxAmount} ${r.currency}` : "—"}</td>
                <td data-label={t("Активно")}>
                  <span className={r.active ? "badge badge-success" : "badge"}>{r.active ? t("Да") : t("Не")}</span>
                </td>
                {isSuperAdmin && (
                  <td className="row-actions">
                    <div className="row-actions-group">
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
                    </div>
                  </td>
                )}
              </tr>
              {isSuperAdmin && editingId === r.id && (
                <tr>
                  <td colSpan={8}>
                    <RuleForm
                      rule={r}
                      allEmployees={employees}
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
    </div>
  );
}

function RuleForm({
  rule,
  allEmployees,
  onSaved,
  onCancel,
}: {
  rule?: FineRule;
  allEmployees: User[];
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const isEdit = Boolean(rule);
  const [name, setName] = useState(rule?.name ?? "");
  const [baseAmount, setBaseAmount] = useState(String(rule?.baseAmount ?? 20));
  const [perDayAmount, setPerDayAmount] = useState(String(rule?.perDayAmount ?? 10));
  const [graceHours, setGraceHours] = useState(String(rule?.graceHours ?? 2));
  const [maxAmount, setMaxAmount] = useState(rule?.maxAmount != null ? String(rule.maxAmount) : "");
  const [currency, setCurrency] = useState(rule?.currency ?? "EUR");
  const [userIds, setUserIds] = useState<string[]>(rule?.assignedUsers.map((a) => a.userId) ?? []);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function toggleUser(id: string) {
    setUserIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const body = {
        name,
        baseAmount: Number(baseAmount),
        perDayAmount: Number(perDayAmount),
        graceHours: Number(graceHours),
        maxAmount: maxAmount ? Number(maxAmount) : null,
        currency,
      };
      let ruleId = rule?.id;
      if (isEdit) {
        await api(`/fine-rules/${rule!.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        const created = await api<FineRule>("/fine-rules", { method: "POST", body: JSON.stringify(body) });
        ruleId = created.id;
      }
      await api(`/fine-rules/${ruleId}/assignees`, { method: "PUT", body: JSON.stringify({ userIds }) });
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
      <label>
        {t("Акаунти, глобени по това правило")}
        <div className="scope-picker">
          {allEmployees.length === 0 && <span className="muted small">{t("Няма налични служители.")}</span>}
          {allEmployees.map((emp) => (
            <label key={emp.id} className="checkbox-label">
              <input type="checkbox" checked={userIds.includes(emp.id)} onChange={() => toggleUser(emp.id)} />
              {emp.name}
            </label>
          ))}
        </div>
        <span className="muted small">
          {t("Без избрани акаунти това правило важи като общо правило за всички останали.")}
        </span>
      </label>
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
