import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import type { TeamUser } from "../api/types";
import { AccordionItem } from "../components/Accordion";
import { useAuth } from "../context/AuthContext";
import { useT } from "../i18n/I18nContext";

export function Settings() {
  const t = useT();
  const { user: me, needsAdminClaim } = useAuth();

  return (
    <div>
      <div className="page-header">
        <h1>{t("Настройки")}</h1>
      </div>

      {needsAdminClaim && (
        <div className="settings-section">
          <h2>{t("Заяви права на върховен администратор")}</h2>
          <ClaimAdminCard />
        </div>
      )}

      <div className="settings-section">
        {me?.isUltimateAdmin ? (
          <>
            <h2>{t("Екип")}</h2>
            <TeamSection />
          </>
        ) : (
          <>
            <h2>{t("Моят акаунт")}</h2>
            <MyAccountCard />
          </>
        )}
      </div>
    </div>
  );
}

// Shown only while no account anywhere is an ultimate admin (see
// AuthContext's needsAdminClaim) — the same DASHBOARD_PASSWORD one-time key
// /login's bootstrap form uses, but for "accounts already exist, none of
// them got the role" instead of "no accounts exist yet" (e.g. this account
// was created before the ultimate-admin role existed).
function ClaimAdminCard() {
  const t = useT();
  const { claimAdmin } = useAuth();
  const [dashboardPassword, setDashboardPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await claimAdmin(dashboardPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <p className="muted small" style={{ margin: 0 }}>
        {t(
          "Все още няма акаунт с права на върховен администратор тук (този акаунт е отпреди въвеждането на тази роля, или последният администратор е бил премахнат). Въведете еднократния ключ"
        )}{" "}
        <code>DASHBOARD_PASSWORD</code>{" "}
        {t("на тази инсталация, за да станете първият — същият еднократен ключ, използван при самата първоначална настройка при вход.")}
      </p>
      <label>
        {t("Парола за таблото")}
        <input
          type="password"
          value={dashboardPassword}
          onChange={(e) => setDashboardPassword(e.target.value)}
          placeholder={t("от DASHBOARD_PASSWORD")}
          required
        />
      </label>
      {error && <div className="error-text">{error}</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? t("Заявяване…") : t("Заяви права на върховен администратор")}
      </button>
    </form>
  );
}

// Self-service name/password change — shown to every account, admin or
// not. Managing anyone ELSE's account (TeamSection below) is restricted to
// ultimate admins; this never sees or touches another user's row.
function MyAccountCard() {
  const t = useT();
  const { user: me, updateProfile } = useAuth();
  const [name, setName] = useState(me?.name ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setSubmitting(true);
    try {
      const fields: { name?: string; password?: string } = {};
      if (name !== me?.name) fields.name = name;
      if (password) fields.password = password;
      await updateProfile(fields);
      setPassword("");
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <p className="muted small" style={{ margin: 0 }}>
        {t("{email} — само върховен администратор може да вижда или променя акаунтите на останалите колеги.", {
          email: me?.email ?? "",
        })}
      </p>
      <label>
        {t("Име")}
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        {t("Нова парола")} <span className="muted">{t("(оставете празно, за да запазите текущата)")}</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} placeholder={t("мин. 8 символа")} />
      </label>
      {error && <div className="error-text">{error}</div>}
      {success && (
        <div className="small" style={{ color: "var(--success)" }}>
          {t("Запазено.")}
        </div>
      )}
      <button type="submit" disabled={submitting}>
        {submitting ? t("Запазване…") : t("Запази промените")}
      </button>
    </form>
  );
}

function TeamSection() {
  const t = useT();
  const { user: me } = useAuth();
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addingUser, setAddingUser] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setUsers(await api<TeamUser[]>("/users"));
  }

  useEffect(() => {
    refresh();
  }, []);

  function toggle(id: string) {
    setAddingUser(false);
    setExpandedId((cur) => (cur === id ? null : id));
  }

  async function toggleActive(u: TeamUser) {
    setError(null);
    try {
      await api(`/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ active: !u.active }) });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    }
  }

  async function remove(u: TeamUser) {
    if (!window.confirm(t("Премахване на {name}? Записите му в одит лога се запазват.", { name: u.name }))) return;
    setError(null);
    try {
      await api(`/users/${u.id}`, { method: "DELETE" });
      if (expandedId === u.id) setExpandedId(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    }
  }

  return (
    <div>
      <p className="muted small">
        {t(
          "Само върховни администратори могат да виждат или управляват този списък. Данните за магазините и цените са споделени от всички — това е само управление на акаунти, така че промените се приписват на конкретен човек (виж Одит лог), вместо на една обща парола."
        )}
      </p>
      {error && (
        <div className="error-text" style={{ marginBottom: 10 }}>
          {error}
        </div>
      )}

      <div className="entity-list" style={{ marginBottom: addingUser ? 12 : 0 }}>
        {users.map((u) => (
          <AccordionItem
            key={u.id}
            open={expandedId === u.id}
            onToggle={() => toggle(u.id)}
            headerLeft={
              <span>
                {u.name} <span className="accordion-meta">{u.email}</span>
                {u.isUltimateAdmin && <span className="tag">{t("върховен администратор")}</span>}
                {!u.active && <span className="tag">{t("деактивиран")}</span>}
                {u.id === me?.id && <span className="tag">{t("вие")}</span>}
              </span>
            }
            headerRight={
              <div className="entity-row-actions" onClick={(e) => e.stopPropagation()}>
                {u.id !== me?.id && (
                  <button className="small-btn secondary" onClick={() => toggleActive(u)}>
                    {u.active ? t("Деактивирай") : t("Активирай")}
                  </button>
                )}
                {u.id !== me?.id && (
                  <button className="small-btn secondary" onClick={() => remove(u)}>
                    {t("Изтрий")}
                  </button>
                )}
              </div>
            }
          >
            <TeamUserForm
              user={u}
              onDone={() => {
                setExpandedId(null);
                refresh();
              }}
              onCancel={() => setExpandedId(null)}
            />
          </AccordionItem>
        ))}
        {users.length === 0 && <p className="muted">{t("Все още няма колеги.")}</p>}
      </div>

      {!addingUser && !expandedId && (
        <button
          onClick={() => {
            setExpandedId(null);
            setAddingUser(true);
          }}
        >
          {t("+ Добави колега")}
        </button>
      )}
      {addingUser && (
        <div className="accordion-item">
          <div className="accordion-body" style={{ borderTop: "none" }}>
            <TeamUserForm
              user={null}
              onDone={() => {
                setAddingUser(false);
                refresh();
              }}
              onCancel={() => setAddingUser(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function TeamUserForm({ user, onDone, onCancel }: { user: TeamUser | null; onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const { user: me } = useAuth();
  const isEdit = Boolean(user);
  const isSelf = user?.id === me?.id;
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [isUltimateAdmin, setIsUltimateAdmin] = useState(user?.isUltimateAdmin ?? false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isEdit && password.length < 8) {
      setError(t("Паролата трябва да е поне 8 символа."));
      return;
    }
    setSubmitting(true);
    try {
      if (isEdit) {
        const body: Record<string, unknown> = { name, email, isUltimateAdmin };
        if (password) body.password = password;
        await api(`/users/${user!.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api("/users", { method: "POST", body: JSON.stringify({ name, email, password, isUltimateAdmin }) });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form" style={{ marginBottom: 0 }} onSubmit={handleSubmit}>
      <div className="form-row">
        <label>
          {t("Име")}
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          {t("Имейл")}
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
      </div>
      <label>
        {isEdit ? t("Нова парола") : t("Парола")}{" "}
        {isEdit && <span className="muted">{t("(оставете празно, за да запазите текущата)")}</span>}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} placeholder={t("мин. 8 символа")} />
      </label>
      <label
        style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
        title={isSelf ? t("Помолете друг върховен администратор да промени вашия администраторски статус.") : undefined}
      >
        <input
          type="checkbox"
          checked={isUltimateAdmin}
          onChange={(e) => setIsUltimateAdmin(e.target.checked)}
          disabled={isSelf}
        />
        {t("Върховен администратор — може да вижда/управлява всички акаунти, не само своя")}
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? t("Запазване…") : isEdit ? t("Запази промените") : t("Добави колега")}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t("Отказ")}
        </button>
      </div>
    </form>
  );
}
