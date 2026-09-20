import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api } from "../api/client";
import type { TeamUser } from "../api/types";
import { AccordionItem } from "../components/Accordion";
import { useAuth } from "../context/AuthContext";

export function Settings() {
  const { user: me, needsAdminClaim } = useAuth();

  return (
    <div>
      <div className="page-header">
        <h1>Settings</h1>
      </div>

      {needsAdminClaim && (
        <div className="settings-section">
          <h2>Claim ultimate admin</h2>
          <ClaimAdminCard />
        </div>
      )}

      <div className="settings-section">
        {me?.isUltimateAdmin ? (
          <>
            <h2>Team</h2>
            <TeamSection />
          </>
        ) : (
          <>
            <h2>My account</h2>
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
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <p className="muted small" style={{ margin: 0 }}>
        No account here is an ultimate admin yet (this one predates that role, or the last admin was removed). Enter
        this deploy's <code>DASHBOARD_PASSWORD</code> to become the first one — same one-time key the very first
        login setup used.
      </p>
      <label>
        Dashboard password
        <input
          type="password"
          value={dashboardPassword}
          onChange={(e) => setDashboardPassword(e.target.value)}
          placeholder="from DASHBOARD_PASSWORD"
          required
        />
      </label>
      {error && <div className="error-text">{error}</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Claiming…" : "Claim ultimate admin"}
      </button>
    </form>
  );
}

// Self-service name/password change — shown to every account, admin or
// not. Managing anyone ELSE's account (TeamSection below) is restricted to
// ultimate admins; this never sees or touches another user's row.
function MyAccountCard() {
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
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <p className="muted small" style={{ margin: 0 }}>
        {me?.email} — only an ultimate admin can see or change other teammates' accounts.
      </p>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label>
        New password <span className="muted">(leave blank to keep the current one)</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} placeholder="min. 8 characters" />
      </label>
      {error && <div className="error-text">{error}</div>}
      {success && <div className="small" style={{ color: "var(--success)" }}>Saved.</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}

function TeamSection() {
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
      setError(err instanceof Error ? err.message : "Error");
    }
  }

  async function remove(u: TeamUser) {
    if (!window.confirm(`Remove ${u.name}? Their past audit-log entries are kept.`)) return;
    setError(null);
    try {
      await api(`/users/${u.id}`, { method: "DELETE" });
      if (expandedId === u.id) setExpandedId(null);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    }
  }

  return (
    <div>
      <p className="muted small">
        Only ultimate admins can see or manage this list. Store and pricing data is shared by everyone — this is
        just account management, so changes are attributed to a real person (see Audit log) instead of one shared
        password.
      </p>
      {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}

      <div className="entity-list" style={{ marginBottom: addingUser ? 12 : 0 }}>
        {users.map((u) => (
          <AccordionItem
            key={u.id}
            open={expandedId === u.id}
            onToggle={() => toggle(u.id)}
            headerLeft={
              <span>
                {u.name} <span className="accordion-meta">{u.email}</span>
                {u.isUltimateAdmin && <span className="tag">ultimate admin</span>}
                {!u.active && <span className="tag">deactivated</span>}
                {u.id === me?.id && <span className="tag">you</span>}
              </span>
            }
            headerRight={
              <div className="entity-row-actions" onClick={(e) => e.stopPropagation()}>
                {u.id !== me?.id && (
                  <button className="small-btn secondary" onClick={() => toggleActive(u)}>
                    {u.active ? "Deactivate" : "Reactivate"}
                  </button>
                )}
                {u.id !== me?.id && (
                  <button className="small-btn secondary" onClick={() => remove(u)}>
                    Delete
                  </button>
                )}
              </div>
            }
          >
            <TeamUserForm user={u} onDone={() => { setExpandedId(null); refresh(); }} onCancel={() => setExpandedId(null)} />
          </AccordionItem>
        ))}
        {users.length === 0 && <p className="muted">No teammates yet.</p>}
      </div>

      {!addingUser && !expandedId && (
        <button
          onClick={() => {
            setExpandedId(null);
            setAddingUser(true);
          }}
        >
          + Add teammate
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
      setError("Password must be at least 8 characters.");
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
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form" style={{ marginBottom: 0 }} onSubmit={handleSubmit}>
      <div className="form-row">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
      </div>
      <label>
        {isEdit ? "New password" : "Password"} {isEdit && <span className="muted">(leave blank to keep the current one)</span>}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} placeholder="min. 8 characters" />
      </label>
      <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }} title={isSelf ? "Ask another ultimate admin to change your own admin status." : undefined}>
        <input
          type="checkbox"
          checked={isUltimateAdmin}
          onChange={(e) => setIsUltimateAdmin(e.target.checked)}
          disabled={isSelf}
        />
        Ultimate admin — can see/manage every account, not just their own
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : isEdit ? "Save changes" : "Add teammate"}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
