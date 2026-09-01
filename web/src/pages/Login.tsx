import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";

export function Login() {
  const { login } = useAuth();
  const { lang, setLang, t } = useI18n();
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
    } catch {
      setError(t("Грешен имейл или парола."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="lang-toggle auth-lang-toggle">
        <button className={lang === "bg" ? "active" : ""} onClick={() => setLang("bg")}>
          БГ
        </button>
        <button className={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>
          EN
        </button>
      </div>
      <form className="auth-card" onSubmit={handleSubmit}>
        <h1>TODF</h1>
        <p className="brand-subtitle-login">{t("Задачи · Owners · Срокове · Глоби")}</p>
        <p className="muted">{t("Влез в системата, за да управляваш задачи и глоби за екипа.")}</p>
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
      </form>
    </div>
  );
}
