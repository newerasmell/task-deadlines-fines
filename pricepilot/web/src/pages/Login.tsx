import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useT } from "../i18n/I18nContext";

export function Login() {
  const { needsSetup, loading } = useAuth();
  const t = useT();

  if (loading) {
    return (
      <div className="auth-page">
        <p className="muted">{t("Зареждане…")}</p>
      </div>
    );
  }

  return <div className="auth-page">{needsSetup ? <SetupCard /> : <LoginCard />}</div>;
}

function LoginCard() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const t = useT();
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
      setError(err instanceof Error ? err.message : t("Грешен имейл или парола."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-card" onSubmit={handleSubmit}>
      <h1>PricePilot</h1>
      <p className="brand-subtitle-login">{t("Табло за конкурентно ценообразуване в Shopify")}</p>
      <label>
        {t("Имейл")}
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
      </label>
      <label>
        {t("Парола")}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      {error && <div className="error-text">{error}</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? t("Влизане…") : t("Вход")}
      </button>
      <p className="muted small" style={{ margin: 0 }}>
        {t("Все още нямаш акаунт? Помоли колега да те добави от Настройки → Екип.")}
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
  const t = useT();
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
      setError(err instanceof Error ? err.message : t("Настройката се провали."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="auth-card" onSubmit={handleSubmit}>
      <h1>PricePilot</h1>
      <p className="brand-subtitle-login">{t("Първоначална настройка — създай първия акаунт за вход")}</p>
      <label>
        {t("Твоето име")}
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </label>
      <label>
        {t("Имейл")}
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label>
        {t("Парола")}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
      </label>
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
      <p className="muted small" style={{ margin: 0 }}>
        {t("Еднократният ключ от env променливата")} <code>DASHBOARD_PASSWORD</code>{" "}
        {t("на този deploy — доказва, че имаш право да създадеш първия акаунт. Всеки следващ колега се добавя отвътре в приложението.")}
      </p>
      {error && <div className="error-text">{error}</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? t("Създаване…") : t("Създай акаунт")}
      </button>
    </form>
  );
}
