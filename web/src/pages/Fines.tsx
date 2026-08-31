import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import type { Fine, FineStatus, User } from "../api/types";
import { useAuth } from "../context/AuthContext";

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

export function Fines() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const [fines, setFines] = useState<Fine[]>([]);
  const [employees, setEmployees] = useState<User[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [waiving, setWaiving] = useState<Fine | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    const f = await api<Fine[]>("/fines");
    setFines(f);
  }

  useEffect(() => {
    const promises: Promise<unknown>[] = [refresh()];
    if (isAdmin) promises.push(api<User[]>("/users").then(setEmployees));
    Promise.all(promises).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function markPaid(id: string) {
    await api(`/fines/${id}/mark-paid`, { method: "POST" });
    refresh();
  }

  if (loading) return <p>Зареждане…</p>;

  return (
    <div>
      <div className="page-header">
        <h1>Глоби</h1>
        {isAdmin && (
          <button onClick={() => setShowForm((s) => !s)}>{showForm ? "Затвори" : "+ Ръчна глоба"}</button>
        )}
      </div>
      <p className="muted">
        Глобите се начисляват автоматично при просрочени задачи според зададените правила в „Настройки“.
        Ако закъснението е основателно, анулирай глобата с обяснение.
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

      <table className="table">
        <thead>
          <tr>
            <th>Служител</th>
            <th>Причина</th>
            <th>Сума</th>
            <th>Дата</th>
            <th>Статус</th>
            {isAdmin && <th></th>}
          </tr>
        </thead>
        <tbody>
          {fines.map((f) => (
            <tr key={f.id}>
              <td>{f.user?.name}</td>
              <td>
                {f.reason}
                {f.waivedReason && <div className="muted small">Анулирана: {f.waivedReason}</div>}
              </td>
              <td>
                {f.amount.toFixed(2)} {f.currency}
              </td>
              <td>{new Date(f.createdAt).toLocaleString("bg-BG")}</td>
              <td>
                <span className={statusClass[f.status]}>{statusLabels[f.status]}</span>
              </td>
              {isAdmin && (
                <td className="row-actions">
                  {f.status === "ACTIVE" && (
                    <>
                      <button className="small-btn" onClick={() => setWaiving(f)}>
                        Анулирай
                      </button>
                      <button className="small-btn" onClick={() => markPaid(f.id)}>
                        Платена
                      </button>
                    </>
                  )}
                </td>
              )}
            </tr>
          ))}
          {fines.length === 0 && (
            <tr>
              <td colSpan={isAdmin ? 6 : 5} className="muted">
                Няма глоби.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ManualFineForm({ employees, onCreated }: { employees: User[]; onCreated: () => void }) {
  const [userId, setUserId] = useState(employees[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!userId) {
      setError("Избери служител.");
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
      setError(err instanceof Error ? err.message : "Грешка");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <div className="form-row">
        <label>
          Служител
          <select value={userId} onChange={(e) => setUserId(e.target.value)} required>
            <option value="" disabled>
              Избери…
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
          Сума (BGN)
          <input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>
      </div>
      <label>
        Причина
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Напр. неоснователно закъснение без уведомление" required />
      </label>
      {error && <div className="error-text">{error}</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Записване…" : "Наложи глоба"}
      </button>
    </form>
  );
}

function WaiveForm({ fine, onDone, onCancel }: { fine: Fine; onDone: () => void; onCancel: () => void }) {
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
      setError(err instanceof Error ? err.message : "Грешка");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <p>
        Анулиране на глоба за <strong>{fine.user?.name}</strong> ({fine.amount.toFixed(2)} {fine.currency})
      </p>
      <label>
        Обосновка (защо закъснението е основателно)
        <input value={reason} onChange={(e) => setReason(e.target.value)} required autoFocus />
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? "Записване…" : "Потвърди анулиране"}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Отказ
        </button>
      </div>
    </form>
  );
}
