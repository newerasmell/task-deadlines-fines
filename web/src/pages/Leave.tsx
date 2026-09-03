import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import type { Leave as LeaveEntry, RescheduleRequest, User } from "../api/types";
import { RESCHEDULE_STATUS_LABELS } from "../api/types";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";

const WEEKDAY_HEADERS = ["Пон", "Вт", "Ср", "Чет", "Пет", "Съб", "Нед"];

function dayOnly(iso: string): Date {
  const d = new Date(iso);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function Leave() {
  const { user } = useAuth();
  const { t, lang } = useI18n();
  const locale = lang === "en" ? "en-GB" : "bg-BG";
  const isAdmin = user?.role === "ADMIN";

  const [employees, setEmployees] = useState<User[]>([]);
  const [selectedUserId, setSelectedUserId] = useState(user?.id ?? "");
  const [leaves, setLeaves] = useState<LeaveEntry[]>([]);
  const [requests, setRequests] = useState<RescheduleRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [monthCursor, setMonthCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impactMsg, setImpactMsg] = useState<string | null>(null);

  useEffect(() => {
    if (user?.id) setSelectedUserId(user.id);
  }, [user?.id]);

  async function refreshLeaves(uid: string) {
    if (!uid) return;
    setLeaves(await api<LeaveEntry[]>(`/leaves?userId=${encodeURIComponent(uid)}`));
  }
  async function refreshRequests() {
    setRequests(await api<RescheduleRequest[]>("/reschedule-requests"));
  }

  useEffect(() => {
    const promises: Promise<unknown>[] = [refreshRequests()];
    if (isAdmin) promises.push(api<User[]>("/users").then((all) => setEmployees(all.filter((e) => e.active))));
    Promise.all(promises).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedUserId) refreshLeaves(selectedUserId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUserId]);

  async function submitLeave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setImpactMsg(null);
    if (!startDate || !endDate) {
      setError(t("Избери начална и крайна дата."));
      return;
    }
    if (endDate < startDate) {
      setError(t("Крайната дата трябва да е след началната."));
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { startDate, endDate, note: note || undefined };
      if (isAdmin && selectedUserId !== user?.id) body.userId = selectedUserId;
      const result = await api<LeaveEntry & { impactedTasksCount: number }>("/leaves", { method: "POST", body: JSON.stringify(body) });
      setStartDate("");
      setEndDate("");
      setNote("");
      if (result.impactedTasksCount > 0) {
        setImpactMsg(
          t("Блокирано. {count} задача(и) са засегнати — изпратена е заявка за нов срок до отговорника за всяка.", {
            count: result.impactedTasksCount,
          })
        );
      }
      refreshLeaves(selectedUserId);
      refreshRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteLeave(id: string) {
    if (!window.confirm(t("Да премахна ли този блокиран период? Вече одобрени нови срокове не се връщат обратно."))) return;
    await api(`/leaves/${id}`, { method: "DELETE" });
    refreshLeaves(selectedUserId);
  }

  async function approveRequest(id: string) {
    await api(`/reschedule-requests/${id}/approve`, { method: "POST" });
    refreshRequests();
  }

  async function rejectRequest(id: string) {
    const reason = window.prompt(t("Причина за отхвърляне:"));
    if (!reason) return;
    await api(`/reschedule-requests/${id}/reject`, { method: "POST", body: JSON.stringify({ decisionNote: reason }) });
    refreshRequests();
  }

  const calendarDays = useMemo(() => {
    const year = monthCursor.getFullYear();
    const month = monthCursor.getMonth();
    const first = new Date(year, month, 1);
    const startOffset = (first.getDay() + 6) % 7; // Monday-first grid
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: (Date | null)[] = [];
    for (let i = 0; i < startOffset; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
    return cells;
  }, [monthCursor]);

  function isBlocked(day: Date): boolean {
    return leaves.some((lv) => day >= dayOnly(lv.startDate) && day <= dayOnly(lv.endDate));
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (loading) return <p>{t("Зареждане…")}</p>;

  const incoming = requests.filter((r) => r.status === "PENDING" && (isAdmin || r.task.ownerId === user?.id));
  const outgoing = requests.filter((r) => r.requestedBy.id === user?.id);

  return (
    <div>
      <div className="page-header">
        <h1>{t("Отпуска")}</h1>
      </div>
      <p className="muted">
        {t(
          "Блокирай дни, в които няма да работиш. Глобите спират да текат за теб през тези дни, а за задачите ти със срок в периода автоматично се изпраща заявка за нов срок до отговорника — той решава дали да го одобри."
        )}
      </p>

      {isAdmin && (
        <div className="form-row" style={{ margin: "0 0 12px" }}>
          <label>
            {t("Служител")}
            <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)}>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.id === user?.id ? t("Ти") : emp.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="calendar-header">
          <button type="button" className="small-btn" onClick={() => setMonthCursor((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))}>
            ‹
          </button>
          <strong>{monthCursor.toLocaleDateString(locale, { month: "long", year: "numeric" })}</strong>
          <button type="button" className="small-btn" onClick={() => setMonthCursor((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))}>
            ›
          </button>
        </div>
        <div className="calendar-grid">
          {WEEKDAY_HEADERS.map((w) => (
            <div key={w} className="calendar-weekday">
              {t(w)}
            </div>
          ))}
          {calendarDays.map((day, i) => (
            <div
              key={i}
              className={`calendar-day${!day ? " calendar-day-empty" : ""}${day && isBlocked(day) ? " calendar-day-blocked" : ""}${
                day && day.getTime() === today.getTime() ? " calendar-day-today" : ""
              }`}
            >
              {day?.getDate()}
            </div>
          ))}
        </div>
      </div>

      <form className="card form" onSubmit={submitLeave}>
        <div className="form-row">
          <label>
            {t("Начало")}
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </label>
          <label>
            {t("Край")}
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
          </label>
        </div>
        <label>
          {t("Бележка (по избор)")}
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {error && <div className="error-text">{error}</div>}
        {impactMsg && <div className="muted small">{impactMsg}</div>}
        <button type="submit" disabled={submitting}>
          {submitting ? t("Записване…") : t("Блокирай дните")}
        </button>
      </form>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t("Начало")}</th>
              <th>{t("Край")}</th>
              <th>{t("Бележка")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {leaves.map((lv) => (
              <tr key={lv.id}>
                <td data-label={t("Начало")}>{new Date(lv.startDate).toLocaleDateString(locale)}</td>
                <td data-label={t("Край")}>{new Date(lv.endDate).toLocaleDateString(locale)}</td>
                <td data-label={t("Бележка")}>{lv.note ?? "—"}</td>
                <td className="row-actions">
                  <button className="small-btn" onClick={() => deleteLeave(lv.id)}>
                    {t("Изтрий")}
                  </button>
                </td>
              </tr>
            ))}
            {leaves.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  {t("Няма блокирани дни.")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {incoming.length > 0 && (
        <>
          <h2>{t("Заявки за нов срок — чакат твоето решение")}</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("Задача")}</th>
                  <th>{t("Служител")}</th>
                  <th>{t("Текущ срок")}</th>
                  <th>{t("Предложен срок")}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {incoming.map((r) => (
                  <tr key={r.id}>
                    <td data-label={t("Задача")}>{r.task.title}</td>
                    <td data-label={t("Служител")}>{r.requestedBy.name}</td>
                    <td data-label={t("Текущ срок")}>{new Date(r.currentDeadline).toLocaleString(locale)}</td>
                    <td data-label={t("Предложен срок")}>{new Date(r.proposedDeadline).toLocaleString(locale)}</td>
                    <td className="row-actions">
                      <div className="row-actions-group">
                        <button className="small-btn" onClick={() => approveRequest(r.id)}>
                          {t("Одобри")}
                        </button>
                        <button className="small-btn" onClick={() => rejectRequest(r.id)}>
                          {t("Отхвърли")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {outgoing.length > 0 && (
        <>
          <h2>{t("Моите заявки за нов срок")}</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("Задача")}</th>
                  <th>{t("Предложен срок")}</th>
                  <th>{t("Статус")}</th>
                </tr>
              </thead>
              <tbody>
                {outgoing.map((r) => (
                  <tr key={r.id}>
                    <td data-label={t("Задача")}>{r.task.title}</td>
                    <td data-label={t("Предложен срок")}>{new Date(r.proposedDeadline).toLocaleString(locale)}</td>
                    <td data-label={t("Статус")}>
                      <span className={r.status === "APPROVED" ? "badge badge-success" : r.status === "REJECTED" ? "badge badge-danger" : "badge"}>
                        {t(RESCHEDULE_STATUS_LABELS[r.status])}
                      </span>
                      {r.status === "REJECTED" && r.decisionNote && <div className="muted small">{r.decisionNote}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
