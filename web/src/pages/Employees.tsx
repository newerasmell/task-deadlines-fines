import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import type { Role, User } from "../api/types";
import { Avatar } from "../components/Avatar";
import { IconSearch } from "../components/icons";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";

export function Employees() {
  const { user: currentUser } = useAuth();
  const isSuperAdmin = Boolean(currentUser?.isSuperAdmin);
  const { t } = useI18n();
  const [users, setUsers] = useState<User[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  async function refresh() {
    setUsers(await api<User[]>("/users"));
  }

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, []);

  async function testSend(userId: string) {
    setTestResult(t("Изпращане…"));
    try {
      const res = await api<{ results: { channel: string; status: string; error?: string }[] }>(
        "/notifications/test-send",
        { method: "POST", body: JSON.stringify({ userId }) }
      );
      if (res.results.length === 0) {
        setTestResult(t("Няма настроени канали с данни за този служител."));
      } else {
        setTestResult(res.results.map((r) => `${r.channel}: ${r.status}${r.error ? ` (${r.error})` : ""}`).join(" · "));
      }
    } catch (err) {
      setTestResult(err instanceof Error ? t(err.message) : t("Грешка"));
    }
  }

  async function deactivate(id: string) {
    await api(`/users/${id}`, { method: "DELETE" });
    refresh();
  }

  if (loading) return <p>{t("Зареждане…")}</p>;

  const visibleUsers = users.filter(
    (u) => !search || u.name.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <div className="page-header">
        <h1>{t("Служители")}</h1>
        <button onClick={() => setShowForm((s) => !s)}>{showForm ? t("Затвори") : t("+ Нов служител")}</button>
      </div>
      <p className="muted">
        {t(
          "„Мениджър“ не е отделна роля тук — всеки служител става мениджър на дадена задача, щом бъде избран за неин „Owner“ при създаване/редакция на задачата (в „Задачи“). Ролята по-долу определя само дали човекът има администраторски достъп (вижда и променя всичко) или е обикновен служител."
        )}
      </p>
      {isSuperAdmin && (
        <p className="muted">
          {t(
            "„Отговорник“ може да раздава задачи на служителите в неговия обхват (виж „Обхват“ при редакция). „Ultimate Admin“ е единственото ниво, което може да дава администраторски/отговорнически права на други."
          )}
        </p>
      )}

      {showForm && (
        <EmployeeForm
          allEmployees={users}
          isSuperAdmin={isSuperAdmin}
          onSaved={() => {
            setShowForm(false);
            refresh();
          }}
        />
      )}

      {editing && (
        <EmployeeForm
          user={editing}
          allEmployees={users}
          isSuperAdmin={isSuperAdmin}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      )}

      {testResult && <div className="card notice">{testResult}</div>}

      <div className="filter-bar">
        <div className="search-input">
          <IconSearch size={16} />
          <input placeholder={t("Търсене по име или имейл…")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>

      <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t("Име")}</th>
            <th>{t("Имейл")}</th>
            <th>{t("Роля")}</th>
            <th>{t("Канали")}</th>
            <th>{t("Статус")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {visibleUsers.map((u) => (
            <tr key={u.id}>
              <td className="person-cell">
                <Avatar id={u.id} name={u.name} />
                {u.name}
              </td>
              <td>{u.email}</td>
              <td>
                {u.role === "ADMIN" ? t("Администратор") : t("Служител")}
                {u.isSuperAdmin && <span className="badge badge-info" style={{ marginLeft: 6 }}>Ultimate</span>}
                {u.canAssignTasks && (
                  <span className="badge" style={{ marginLeft: 6 }}>
                    {t("Отговорник")}
                  </span>
                )}
              </td>
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
                <span className={u.active ? "badge badge-success" : "badge"}>{u.active ? t("Активен") : t("Деактивиран")}</span>
              </td>
              <td className="row-actions">
                <button className="small-btn" onClick={() => setEditing(u)}>
                  {t("Редактирай")}
                </button>
                <button className="small-btn" onClick={() => testSend(u.id)}>
                  {t("Тест известие")}
                </button>
                {u.active && (
                  <button className="small-btn" onClick={() => deactivate(u.id)}>
                    {t("Деактивирай")}
                  </button>
                )}
              </td>
            </tr>
          ))}
          {visibleUsers.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                {t("Няма служители.")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function EmployeeForm({
  user,
  allEmployees,
  isSuperAdmin,
  onSaved,
  onCancel,
}: {
  user?: User;
  allEmployees: User[];
  isSuperAdmin: boolean;
  onSaved: () => void;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  const isEdit = Boolean(user);
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "EMPLOYEE");
  const [canAssignTasks, setCanAssignTasks] = useState(user?.canAssignTasks ?? false);
  const [isSuperAdminFlag, setIsSuperAdminFlag] = useState(user?.isSuperAdmin ?? false);
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState(user?.phone ?? "");
  const [telegramChatId, setTelegramChatId] = useState(user?.telegramChatId ?? "");
  const [slackMemberId, setSlackMemberId] = useState(user?.slackMemberId ?? "");
  const [whatsappPhone, setWhatsappPhone] = useState(user?.whatsappPhone ?? "");
  const [viberUserId, setViberUserId] = useState(user?.viberUserId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isSuperAdmin && user) {
      api<string[]>(`/users/${user.id}/scope`).then(setScopeIds);
    }
  }, [isSuperAdmin, user]);

  function toggleScope(id: string) {
    setScopeIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const channels = { phone, telegramChatId, slackMemberId, whatsappPhone, viberUserId };
      const permissions = isSuperAdmin ? { role, canAssignTasks, isSuperAdmin: isSuperAdminFlag } : {};
      let savedId = user?.id;
      if (isEdit && user) {
        await api(`/users/${user.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name,
            email: email !== user.email ? email : undefined,
            password: password || undefined,
            ...permissions,
            ...channels,
          }),
        });
      } else {
        const created = await api<User>("/users", {
          method: "POST",
          body: JSON.stringify({ name, email, password, role: isSuperAdmin ? role : "EMPLOYEE", ...permissions, ...channels }),
        });
        savedId = created.id;
      }
      if (isSuperAdmin && savedId && canAssignTasks) {
        await api(`/users/${savedId}/scope`, { method: "PUT", body: JSON.stringify({ employeeIds: scopeIds }) });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? t(err.message) : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  const scopeCandidates = allEmployees.filter((e) => e.id !== user?.id && e.role !== "ADMIN" && e.active);

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <div className="form-row">
        <label>
          {t("Име")}
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          {t("Имейл")}
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        {isSuperAdmin && (
          <label>
            {t("Роля")}
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="EMPLOYEE">{t("Служител")}</option>
              <option value="ADMIN">{t("Администратор")}</option>
            </select>
          </label>
        )}
        <label>
          {isEdit ? t("Нова парола (остави празно, за да не се сменя)") : t("Парола")}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required={!isEdit}
            minLength={6}
            placeholder={isEdit ? "••••••••" : undefined}
          />
        </label>
      </div>

      {isSuperAdmin && (
        <>
          <h3>{t("Права за раздаване на задачи")}</h3>
          <div className="form-row">
            <label className="checkbox-label">
              <input type="checkbox" checked={canAssignTasks} onChange={(e) => setCanAssignTasks(e.target.checked)} />
              {t("Отговорник — може да раздава задачи на служители в неговия обхват")}
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={isSuperAdminFlag} onChange={(e) => setIsSuperAdminFlag(e.target.checked)} />
              {t("Ultimate Admin — може да дава администраторски/отговорнически права на други")}
            </label>
          </div>
          {canAssignTasks && (
            <label>
              {t("Обхват — на кои служители може да раздава задачи")}
              <div className="scope-picker">
                {scopeCandidates.length === 0 && <span className="muted small">{t("Няма налични служители.")}</span>}
                {scopeCandidates.map((e) => (
                  <label key={e.id} className="checkbox-label">
                    <input type="checkbox" checked={scopeIds.includes(e.id)} onChange={() => toggleScope(e.id)} />
                    {e.name}
                  </label>
                ))}
              </div>
            </label>
          )}
        </>
      )}

      <h3>{t("Канали за известия")}</h3>
      <p className="muted small">
        {t("Попълни идентификаторите, за да получава служителят известия и на тези канали. Виж „Настройки“ за инструкции как да ги вземеш.")}
      </p>
      <div className="form-row">
        <label>
          {t("Телефон")}
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
          {t("WhatsApp номер")}
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
          {submitting ? t("Записване…") : isEdit ? t("Запази промените") : t("Създай служител")}
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
