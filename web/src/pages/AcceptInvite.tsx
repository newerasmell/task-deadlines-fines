import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { AuthUser } from "../context/AuthContext";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";

type InviteState = { status: "loading" } | { status: "invalid" } | { status: "valid"; name: string; email: string };

// Public page (not behind RequireAuth — the invited person has no
// account/session yet, same reasoning as Login.tsx) reached from the link
// server/src/lib/invite.ts emails out. Styled identically to Login.tsx
// (same auth-page/auth-card CSS classes) since it's the same "before you
// have a session" family of screen.
export function AcceptInvite() {
  const { setSession } = useAuth();
  const { lang, setLang, t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [invite, setInvite] = useState<InviteState>({ status: "loading" });
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      setInvite({ status: "invalid" });
      return;
    }
    api<{ valid: boolean; name?: string; email?: string }>(`/auth/invite/${encodeURIComponent(token)}`)
      .then((res) => setInvite(res.valid ? { status: "valid", name: res.name!, email: res.email! } : { status: "invalid" }))
      .catch(() => setInvite({ status: "invalid" }));
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError(t("Паролите не съвпадат."));
      return;
    }
    setSubmitting(true);
    try {
      const result = await api<{ token: string; user: AuthUser }>("/auth/accept-invite", {
        method: "POST",
        body: JSON.stringify({ token, password }),
      });
      setSession(result.token, result.user);
      navigate("/");
    } catch {
      setError(t("Нещо се обърка — поканата може да е изтекла. Поискай нова от администратор."));
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

      {invite.status === "loading" && (
        <div className="auth-card">
          <p className="center-loading">{t("Зареждане…")}</p>
        </div>
      )}

      {invite.status === "invalid" && (
        <div className="auth-card">
          <h1>TODF</h1>
          <p className="error-text">{t("Тази покана е невалидна или е изтекла. Поискай нова от администратор.")}</p>
        </div>
      )}

      {invite.status === "valid" && (
        <form className="auth-card" onSubmit={handleSubmit}>
          <h1>TODF</h1>
          <p className="muted">
            {t("Здравей, {name}! Задай си парола, за да влезеш в системата.", { name: invite.name })}
          </p>
          <label>
            {t("Имейл")}
            <input value={invite.email} disabled />
          </label>
          <label>
            {t("Парола")}
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoFocus />
          </label>
          <label>
            {t("Повтори паролата")}
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={6}
            />
          </label>
          {error && <div className="error-text">{error}</div>}
          <button type="submit" disabled={submitting}>
            {submitting ? t("Запазване…") : t("Задай парола и влез")}
          </button>
        </form>
      )}
    </div>
  );
}
