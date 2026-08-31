import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import type { User } from "../api/types";

export function Employees() {
  const [users, setUsers] = useState<User[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setUsers(await api<User[]>("/users"));
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  async function testSend(userId: string) {
    setTestResult("Изпращане…");
    try {
      const res = await api<{ results: { channel: string; status: string; error?: string }[] }>(
        "/notifications/test-send",
        { method: "POST", body: JSON.stringify({ userId }) }
      );
      if (res.results.length === 0) {
        setTestResult("Няма настроени канали с данни за този служител.");
      } else {
        setTestResult(res.results.map((r) => `${r.channel}: ${r.status}${r.error ? ` (${r.error})` : ""}`).join(" · "));
      }
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : "Грешка");
    }
  }

  async function deactivate(id: string) {
    await api(`/users/${id}`, { method: "DELETE" });
    refresh();
  }

  if (loading) return <p>Зареждане…</p>;

  return (
    <div>
      <div className="page-header">
        <h1>Служители</h1>
        <button onClick={() => setShowForm((s) => !s)}>{showForm ? "Затвори" : "+ Нов служител"}</button>
      </div>

      {showForm && (
        <EmployeeForm
          onSaved={() => {
            setShowForm(false);
            refresh();
          }}
        />
      )}

      {editing && (
        <EmployeeForm
          user={editing}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {testResult && <div className="card notice">{testResult}</div>}

      <table className="table">
        <thead>
          <tr>
            <th>Име</th>
            <th>Имейл</th>
            <th>Роля</th>
            <th>Канали</th>
            <th>Статус</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.email}</td>
              <td>{u.role === "ADMIN" ? "Администратор" : "Служител"}</td>
              <td className="small">
                {[
                  u.telegramChatId && "Telegram",
                  u.slackMemberId && "Slack",
                  u.whatsappPhone && "WhatsApp",
                  u.viberUserId && "Viber",
                  "Email",
                ]
                  .filter(Boolean)
                  .join(", ")}
              </td>
              <td>
                <span className={u.active ? "badge badge-success" : "badge"}>{u.active ? "Активен" : "Деактивиран"}</span>
              </td>
              <td className="row-actions">
                <button className="small-btn" onClick={() => setEditing(u)}>
                  Редактирай
                </button>
                <button className="small-btn" onClick={() => testSend(u.id)}>
                  Тест известие
                </button>
                {u.active && (
                  <button className="small-btn" onClick={() => deactivate(u.id)}>
                    Деактивирай
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmployeeForm({ user, onSaved, onCancel }: { user?: User; onSaved: () => void; onCancel?: () => void }) {
  const isEdit = Boolean(user);
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [telegramChatId, setTelegramChatId] = useState(user?.telegramChatId ?? "");
  const [slackMemberId, setSlackMemberId] = useState(user?.slackMemberId ?? "");
  const [whatsappPhone, setWhatsappPhone] = useState(user?.whatsappPhone ?? "");
  const [viberUserId, setViberUserId] = useState(user?.viberUserId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const channels = { phone, telegramChatId, slackMemberId, whatsappPhone, viberUserId };
      if (isEdit && user) {
        await api(`/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ name, ...channels }) });
      } else {
        await api("/users", {
          method: "POST",
          body: JSON.stringify({ name, email, password, role: "EMPLOYEE", ...channels }),
        });
      }
      onSaved();
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
          Име
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        {!isEdit && (
          <>
            <label>
              Имейл
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label>
              Парола
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
            </label>
          </>
        )}
      </div>

      <h3>Канали за известия</h3>
      <p className="muted small">
        Попълни идентификаторите, за да получава служителят известия и на тези канали. Виж „Настройки“ за инструкции как да ги вземеш.
      </p>
      <div className="form-row">
        <label>
          Телефон
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+359..." />
        </label>
        <label>
          Telegram chat ID
          <input value={telegramChatId} onChange={(e) => setTelegramChatId(e.target.value)} placeholder="123456789" />
        </label>
        <label>
          Slack member ID
          <input value={slackMemberId} onChange={(e) => setSlackMemberId(e.target.value)} placeholder="U0123ABCD" />
        </label>
      </div>
      <div className="form-row">
        <label>
          WhatsApp номер
          <input value={whatsappPhone} onChange={(e) => setWhatsappPhone(e.target.value)} placeholder="359888123456" />
        </label>
        <label>
          Viber user ID
          <input value={viberUserId} onChange={(e) => setViberUserId(e.target.value)} placeholder="abc123..." />
        </label>
      </div>

      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? "Записване…" : isEdit ? "Запази промените" : "Създай служител"}
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Отказ
          </button>
        )}
      </div>
    </form>
  );
}
