import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function Login() {
  const { needsSetup, loading } = useAuth();

  if (loading) {
    return (
      <div className="auth-page">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return <div className="auth-page">{needsSetup ? <SetupCard /> : <LoginCard />}</div>;
}

function LoginCard() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wrong email or password.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-card" onSubmit={handleSubmit}>
      <h1>PricePilot</h1>
      <p className="brand-subtitle-login">Shopify Competitive Pricing Dashboard</p>
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      {error && <div className="error-text">{error}</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Signing in…" : "Sign in"}
      </button>
      <p className="muted small" style={{ margin: 0 }}>
        No account yet? Ask a teammate to add you under Settings → Team.
      </p>
    </form>
  );
}

// Shown only while the User table is empty (see AuthContext's needsSetup) —
// the dashboard password from .env is the one-time key that proves whoever
// is filling this in is allowed to create the very first account; every
// later account is added from inside the app instead (Settings → Team).
function SetupCard() {
  const { setup } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [dashboardPassword, setDashboardPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await setup(name, email, password, dashboardPassword);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-card" onSubmit={handleSubmit}>
      <h1>PricePilot</h1>
      <p className="brand-subtitle-login">First-time setup — create the first login</p>
      <label>
        Your name
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </label>
      <label>
        Email
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label>
        Password
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
      </label>
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
      <p className="muted small" style={{ margin: 0 }}>
        The one-time key from this deploy's <code>DASHBOARD_PASSWORD</code> env var — proves you're allowed to create
        the first account. Every teammate after you gets added from inside the app instead.
      </p>
      {error && <div className="error-text">{error}</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? "Creating…" : "Create account"}
      </button>
    </form>
  );
}
