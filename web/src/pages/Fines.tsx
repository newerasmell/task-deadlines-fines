import { Fragment, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Fine, FineStatus, User } from "../api/types";
import { Avatar } from "../components/Avatar";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";

const statusLabels: Record<FineStatus, string> = {
  ACTIVE: "Активна",
  WAIVED: "Анулирана",
  PAID: "Платена",
};

const statusClass: Record<FineStatus, string> = {
  ACTIVE: "badge badge-danger",
  WAIVED: "badge",
  PAID: "badge badge-success",
};

interface FineGroup {
  userId: string;
  user?: { id: string; name: string; email: string };
  fines: Fine[];
  activeTotals: Record<string, number>;
}

function groupFines(fines: Fine[]): FineGroup[] {
  const byUser = new Map<string, FineGroup>();
  for (const f of fines) {
    let group = byUser.get(f.userId);
    if (!group) {
      group = { userId: f.userId, user: f.user, fines: [], activeTotals: {} };
      byUser.set(f.userId, group);
    }
    group.fines.push(f);
    if (f.status === "ACTIVE") {
      group.activeTotals[f.currency] = (group.activeTotals[f.currency] ?? 0) + f.amount;
    }
  }
  return Array.from(byUser.values()).sort((a, b) => totalOwed(b) - totalOwed(a));
}

function totalOwed(group: FineGroup): number {
  return Object.values(group.activeTotals).reduce((s, v) => s + v, 0);
}

function formatTotals(totals: Record<string, number>): string {
  const entries = Object.entries(totals).filter(([, v]) => v > 0);
  if (entries.length === 0) return "0.00";
  return entries.map(([currency, sum]) => `${sum.toFixed(2)} ${currency}`).join(" + ");
}

export function Fines() {
  const { user } = useAuth();
  const { t, lang } = useI18n();
  const locale = lang === "en" ? "en-GB" : "bg-BG";
  const isAdmin = user?.role === "ADMIN";
  const [fines, setFines] = useState<Fine[]>([]);
  const [employees, setEmployees] = useState<User[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [waiving, setWaiving] = useState<Fine | null>(null);
  const [editingAmount, setEditingAmount] = useState<Fine | null>(null);
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [toggledGroups, setToggledGroups] = useState<Set<string>>(new Set());
  const [payingBulk, setPayingBulk] = useState(false);

  async function refresh() {
    const f = await api<Fine[]>("/fines");
    setFines(f);
    setSelectedIds((cur) => {
      const activeIds = new Set(f.filter((fine) => fine.status === "ACTIVE").map((fine) => fine.id));
      const next = new Set<string>();
      for (const id of cur) if (activeIds.has(id)) next.add(id);
      return next;
    });
  }

  useEffect(() => {
    const promises: Promise<unknown>[] = [refresh()];
    if (isAdmin) promises.push(api<User[]>("/users").then(setEmployees));
    Promise.all(promises).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function markPaid(id: string) {
    await api(`/fines/${id}/mark-paid`, { method: "POST" });
    setSelectedIds((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
    refresh();
  }

  async function cleanupDuplicates() {
    if (!window.confirm(t("Да анулирам всички дублирани глоби (породени от вече поправения бъг с повторното начисляване)? Оригиналната глоба за всеки случай остава непроменена.")))
      return;
    setCleaning(true);
    try {
      const result = await api<{ waivedCount: number }>("/fines/cleanup-duplicates", { method: "POST" });
      window.alert(t("Анулирани {count} дублирани глоби.", { count: result.waivedCount }));
      refresh();
    } finally {
      setCleaning(false);
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectedMany(ids: string[], select: boolean) {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      for (const id of ids) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function toggleGroup(userId: string) {
    setToggledGroups((cur) => {
      const next = new Set(cur);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  async function bulkMarkPaid() {
    const selectedFines = fines.filter((f) => selectedIds.has(f.id));
    const totalsByCurrency: Record<string, number> = {};
    for (const f of selectedFines) totalsByCurrency[f.currency] = (totalsByCurrency[f.currency] ?? 0) + f.amount;
    if (
      !window.confirm(
        t("Да маркирам {count} избрани глоби като платени — общо {total}?", {
          count: selectedFines.length,
          total: formatTotals(totalsByCurrency),
        })
      )
    )
      return;
    setPayingBulk(true);
    try {
      await api<{ paidCount: number }>("/fines/mark-paid-bulk", {
        method: "POST",
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });
      setSelectedIds(new Set());
      refresh();
    } finally {
      setPayingBulk(false);
    }
  }

  if (loading) return <p>{t("Зареждане…")}</p>;

  const groups = groupFines(fines);
  const allActiveIds = fines.filter((f) => f.status === "ACTIVE").map((f) => f.id);
  const allSelected = allActiveIds.length > 0 && allActiveIds.every((id) => selectedIds.has(id));
  const selectedTotals: Record<string, number> = {};
  for (const f of fines) if (selectedIds.has(f.id)) selectedTotals[f.currency] = (selectedTotals[f.currency] ?? 0) + f.amount;

  return (
    <div>
      <div className="page-header">
        <h1>{t("Глоби")}</h1>
        <div className="form-row" style={{ margin: 0 }}>
          {user?.isSuperAdmin && (
            <button className="secondary" onClick={cleanupDuplicates} disabled={cleaning}>
              {cleaning ? t("Изчистване…") : t("Изчисти дублирани глоби")}
            </button>
          )}
          {isAdmin && (
            <button onClick={() => setShowForm((s) => !s)}>{showForm ? t("Затвори") : t("+ Ръчна глоба")}</button>
          )}
        </div>
      </div>
      <p className="muted">
        {t("Глобите се начисляват автоматично при просрочени задачи според зададените правила в „Настройки“. Ако закъснението е основателно, анулирай глобата с обяснение.")}
      </p>

      {isAdmin && showForm && (
        <ManualFineForm
          employees={employees}
          onCreated={() => {
            setShowForm(false);
            refresh();
          }}
        />
      )}

      {waiving && (
        <WaiveForm
          fine={waiving}
          onDone={() => {
            setWaiving(null);
            refresh();
          }}
          onCancel={() => setWaiving(null)}
        />
      )}

      {editingAmount && (
        <EditAmountForm
          fine={editingAmount}
          onDone={() => {
            setEditingAmount(null);
            refresh();
          }}
          onCancel={() => setEditingAmount(null)}
        />
      )}

      {isAdmin && selectedIds.size > 0 && (
        <div className="fine-bulk-bar">
          <span>
            {t("Избрани: {count} — общо {total}", { count: selectedIds.size, total: formatTotals(selectedTotals) })}
          </span>
          <span className="spacer" />
          <button onClick={bulkMarkPaid} disabled={payingBulk}>
            {payingBulk ? t("Записване…") : t("Плати избраните")}
          </button>
          <button className="secondary" onClick={() => setSelectedIds(new Set())}>
            {t("Изчисти избора")}
          </button>
        </div>
      )}

      <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {isAdmin && (
              <th>
                {allActiveIds.length > 0 && (
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) => toggleSelectedMany(allActiveIds, e.target.checked)}
                    title={t("Избери всички активни глоби")}
                  />
                )}
              </th>
            )}
            <th>{t("Служител")}</th>
            <th>{t("Задача")}</th>
            <th>{t("Причина")}</th>
            <th>{t("Сума")}</th>
            <th>{t("Дата")}</th>
            <th>{t("Платена на")}</th>
            <th>{t("Статус")}</th>
            {isAdmin && <th></th>}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const owed = totalOwed(group);
            const defaultExpanded = owed > 0;
            const expanded = toggledGroups.has(group.userId) ? !defaultExpanded : defaultExpanded;
            const groupActiveIds = group.fines.filter((f) => f.status === "ACTIVE").map((f) => f.id);
            const groupAllSelected = groupActiveIds.length > 0 && groupActiveIds.every((id) => selectedIds.has(id));
            const colCount = isAdmin ? 9 : 7;
            return (
              <Fragment key={group.userId}>
                <tr className="fine-group-header">
                  {isAdmin && (
                    <td onClick={(e) => e.stopPropagation()}>
                      {groupActiveIds.length > 0 && (
                        <input
                          type="checkbox"
                          checked={groupAllSelected}
                          onChange={(e) => toggleSelectedMany(groupActiveIds, e.target.checked)}
                          title={t("Избери всички активни глоби на този служител")}
                        />
                      )}
                    </td>
                  )}
                  <td colSpan={colCount - (isAdmin ? 1 : 0)} onClick={() => toggleGroup(group.userId)}>
                    <span className="fine-group-toggle">{expanded ? "▾" : "▸"}</span>
                    {group.user && <Avatar id={group.userId} name={group.user.name} size={22} />}{" "}
                    <strong>{group.user?.name ?? "—"}</strong>{" "}
                    <span className="muted small">
                      ({group.fines.length} {group.fines.length === 1 ? t("глоба") : t("глоби")})
                    </span>{" "}
                    {owed > 0 ? (
                      <span className="badge badge-danger">
                        {t("дължи")} {formatTotals(group.activeTotals)}
                      </span>
                    ) : (
                      <span className="badge badge-success">{t("Всичко уредено")}</span>
                    )}
                  </td>
                </tr>
                {expanded &&
                  group.fines.map((f) => (
                    <tr key={f.id}>
                      {isAdmin && (
                        <td>
                          {f.status === "ACTIVE" && (
                            <input type="checkbox" checked={selectedIds.has(f.id)} onChange={() => toggleSelected(f.id)} />
                          )}
                        </td>
                      )}
                      <td className="person-cell" data-label={t("Служител")}>
                        <div className="person-cell-group">
                          {f.user && <Avatar id={f.userId} name={f.user.name} size={22} />}
                          {f.user?.name}
                        </div>
                      </td>
                      <td data-label={t("Задача")}>
                        {f.task ? (
                          <Link to={`/tasks?search=${encodeURIComponent(f.task.title)}`}>{f.task.title}</Link>
                        ) : (
                          <span className="muted">{t("Ръчна глоба")}</span>
                        )}
                      </td>
                      <td data-label={t("Причина")}>
                        {f.reason}
                        {f.waivedReason && <div className="muted small">{t("Анулирана:")} {f.waivedReason}</div>}
                      </td>
                      <td data-label={t("Сума")}>
                        {f.amount.toFixed(2)} {f.currency}
                      </td>
                      <td data-label={t("Дата")}>{new Date(f.createdAt).toLocaleString(locale)}</td>
                      <td data-label={t("Платена на")}>
                        {f.paidAt ? new Date(f.paidAt).toLocaleString(locale) : <span className="muted">—</span>}
                      </td>
                      <td data-label={t("Статус")}>
                        <span className={statusClass[f.status]}>{t(statusLabels[f.status])}</span>
                      </td>
                      {isAdmin && (
                        <td className="row-actions">
                          <div className="row-actions-group">
                            {f.status === "ACTIVE" && (
                              <>
                                <button className="small-btn" onClick={() => setWaiving(f)}>
                                  {t("Анулирай")}
                                </button>
                                <button className="small-btn" onClick={() => markPaid(f.id)}>
                                  {t("Платена")}
                                </button>
                              </>
                            )}
                            {user?.isSuperAdmin && (
                              <button className="small-btn" onClick={() => setEditingAmount(f)}>
                                {t("Редактирай сума")}
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
              </Fragment>
            );
          })}
          {fines.length === 0 && (
            <tr>
              <td colSpan={isAdmin ? 9 : 7} className="muted">
                {t("Няма глоби.")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function ManualFineForm({ employees, onCreated }: { employees: User[]; onCreated: () => void }) {
  const { t } = useI18n();
  const [userId, setUserId] = useState(employees[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!userId) {
      setError(t("Избери служител."));
      return;
    }
    setSubmitting(true);
    try {
      await api("/fines", {
        method: "POST",
        body: JSON.stringify({ userId, amount: Number(amount), reason }),
      });
      onCreated();
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
          {t("Служител")}
          <select value={userId} onChange={(e) => setUserId(e.target.value)} required>
            <option value="" disabled>
              {t("Избери…")}
            </option>
            {employees
              .filter((e) => e.active)
              .map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          {t("Сума (EUR)")}
          <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>
      </div>
      <label>
        {t("Причина")}
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("Напр. неоснователно закъснение без уведомление")} required />
      </label>
      {error && <div className="error-text">{error}</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? t("Записване…") : t("Наложи глоба")}
      </button>
    </form>
  );
}

function EditAmountForm({ fine, onDone, onCancel }: { fine: Fine; onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [amount, setAmount] = useState(String(fine.amount));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api(`/fines/${fine.id}/amount`, {
        method: "PATCH",
        body: JSON.stringify({ amount: Number(amount), reason }),
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <p>
        {t("Редакция на сумата на глоба за")} <strong>{fine.user?.name}</strong> ({t("текуща сума")} {fine.amount.toFixed(2)} {fine.currency})
        {fine.task && (
          <>
            {" "}
            — {t("задача")} <strong>{fine.task.title}</strong>
          </>
        )}
      </p>
      <div className="form-row">
        <label>
          {t("Нова сума")} ({fine.currency})
          <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required autoFocus />
        </label>
      </div>
      <label>
        {t("Причина за корекцията")}
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("Напр. грешно изчислена сума при ескалация")} required />
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? t("Записване…") : t("Запази новата сума")}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t("Отказ")}
        </button>
      </div>
    </form>
  );
}

function WaiveForm({ fine, onDone, onCancel }: { fine: Fine; onDone: () => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api(`/fines/${fine.id}/waive`, { method: "POST", body: JSON.stringify({ reason }) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <p>
        {t("Анулиране на глоба за")} <strong>{fine.user?.name}</strong> ({fine.amount.toFixed(2)} {fine.currency})
        {fine.task && (
          <>
            {" "}
            — {t("задача")} <strong>{fine.task.title}</strong>
          </>
        )}
      </p>
      <label>
        {t("Обосновка (защо закъснението е основателно)")}
        <input value={reason} onChange={(e) => setReason(e.target.value)} required autoFocus />
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? t("Записване…") : t("Потвърди анулиране")}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t("Отказ")}
        </button>
      </div>
    </form>
  );
}
