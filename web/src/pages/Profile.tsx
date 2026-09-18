import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { GoogleCalendarStatus } from "../api/types";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";

// Personal, per-user settings — currently just the "Push to Calendar"
// Google connection (see PushToCalendarButton.tsx). Distinct from the
// admin-only /settings page (fine rules, org-wide config): every user,
// not just admins, needs to reach this one to connect their own calendar.
export function Profile() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [status, setStatus] = useState<GoogleCalendarStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [notice, setNotice] = useState<"connected" | "error" | null>(null);

  async function refresh() {
    setStatus(await api<GoogleCalendarStatus>("/google-calendar/status"));
  }

  useEffect(() => {
    refresh();
    const google = searchParams.get("google");
    if (google === "connected" || google === "error") {
      setNotice(google);
      searchParams.delete("google");
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect() {
    setConnecting(true);
    try {
      const { url } = await api<{ url: string }>("/google-calendar/oauth/start");
      window.location.href = url;
    } catch (err) {
      setConnecting(false);
      alert(err instanceof Error ? err.message : t("Грешка"));
    }
  }

  async function disconnect() {
    if (!window.confirm(t("Наистина ли да прекъснеш връзката с Google Calendar? Вече изпратените събития няма да бъдат изтрити."))) return;
    setDisconnecting(true);
    try {
      await api("/google-calendar/disconnect", { method: "DELETE" });
      await refresh();
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="page">
      <h1>{t("Профил")}</h1>
      {user && (
        <div className="card" style={{ maxWidth: 480 }}>
          <div className="small muted">{t("Име")}</div>
          <div style={{ marginBottom: 10 }}>{user.name}</div>
          <div className="small muted">{t("Имейл")}</div>
          <div>{user.email}</div>
        </div>
      )}

      <div className="card" style={{ maxWidth: 480, marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>{t("Google Calendar")}</h3>
        <p className="muted small">
          {t("Свържи собствения си Google Calendar, за да можеш да изпращаш задачи там директно от бутона \"Push to Calendar\".")}
        </p>

        {notice === "connected" && <p className="small" style={{ color: "var(--success, #1a7f37)" }}>{t("Успешно свързан Google Calendar.")}</p>}
        {notice === "error" && <p className="small error-text">{t("Свързването с Google Calendar не бе успешно. Опитай отново.")}</p>}

        {status === null ? (
          <p className="muted small">{t("Зареждане…")}</p>
        ) : !status.configured ? (
          <p className="muted small">{t("Google Calendar не е конфигуриран на сървъра — свържи се с администратор.")}</p>
        ) : status.connected ? (
          <>
            <p className="small">
              ✓ {t("Свързан")}
              {status.connectedAt ? ` (${new Date(status.connectedAt).toLocaleDateString()})` : ""}
            </p>
            <button className="secondary" onClick={disconnect} disabled={disconnecting}>
              {disconnecting ? t("Прекъсване…") : t("Прекъсни връзката")}
            </button>
          </>
        ) : (
          <button onClick={connect} disabled={connecting}>
            {connecting ? t("Свързване…") : t("Свържи Google Calendar")}
          </button>
        )}
      </div>
    </div>
  );
}
