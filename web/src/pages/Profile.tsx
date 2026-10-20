import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import type { GoogleCalendarStatus } from "../api/types";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";

// How often (and for how long) Profile.tsx re-checks /auth/me while a
// "Свържи Telegram" deep link is open in another tab — Telegram itself
// never redirects the browser back here (unlike the Google Calendar OAuth
// flow below), so the only way to notice the webhook already linked the
// account is to poll.
const TELEGRAM_POLL_INTERVAL_MS = 3000;
const TELEGRAM_POLL_MAX_ATTEMPTS = 20; // ~60s

// Self-service Telegram linking — one click opens the bot with a one-time
// deep-link token (server/src/lib/telegramLink.ts); tapping "Start" in
// Telegram lets the webhook resolve it back to this account with no admin
// involved. Mirrors the Google Calendar card below in shape (connect
// button → external action → auto-detected "connected" state).
function TelegramCard() {
  const { user, refreshUser } = useAuth();
  const { t } = useI18n();
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function connect() {
    setConnecting(true);
    setError(null);
    try {
      const { deepLink } = await api<{ token: string; botUsername: string; deepLink: string }>("/telegram-link/token", {
        method: "POST",
      });
      window.open(deepLink, "_blank");

      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts++;
        await refreshUser();
        if (attempts >= TELEGRAM_POLL_MAX_ATTEMPTS && pollRef.current) {
          clearInterval(pollRef.current);
          setConnecting(false);
        }
      }, TELEGRAM_POLL_INTERVAL_MS);
    } catch (err) {
      setConnecting(false);
      setError(err instanceof Error ? err.message : t("Грешка"));
    }
  }

  // The poll above calls refreshUser(), which replaces `user` in context —
  // once telegramChatId shows up there, stop polling and show "Свързан".
  useEffect(() => {
    if (connecting && user?.telegramChatId && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      setConnecting(false);
    }
  }, [connecting, user?.telegramChatId]);

  return (
    <div className="card" style={{ maxWidth: 480, marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Telegram</h3>
      <p className="muted small">
        {t("Свържи своя Telegram с едно кликване, за да получаваш напомняния за задачи и глоби директно там.")}
      </p>
      {error && <p className="small error-text">{error}</p>}
      {user?.telegramChatId ? (
        <>
          <p className="small">✓ {t("Свързан")}</p>
          <button className="secondary" onClick={connect} disabled={connecting}>
            {connecting ? t("Свързване…") : t("Промени")}
          </button>
        </>
      ) : (
        <>
          <button onClick={connect} disabled={connecting}>
            {connecting ? t("Изчакване да натиснеш Start в Telegram…") : t("Свържи Telegram")}
          </button>
          {connecting && (
            <p className="muted small" style={{ marginTop: 8 }}>
              {t('Отвори се Telegram — натисни "Start" там, тази страница ще се обнови сама.')}
            </p>
          )}
        </>
      )}
    </div>
  );
}

// Slack has no self-service OAuth app configured, so linking stays a
// guided copy-paste: the employee finds their own Member ID in Slack's UI
// and saves it here, which PATCHes their own user row — the same
// self-edit path the admin-only Employees page already uses for every
// employee's notification identities.
function SlackCard() {
  const { user, refreshUser } = useAuth();
  const { t } = useI18n();
  const [value, setValue] = useState(user?.slackMemberId ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setValue(user?.slackMemberId ?? "");
  }, [user?.slackMemberId]);

  async function save() {
    if (!user) return;
    setSaving(true);
    setSaved(false);
    try {
      await api(`/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ slackMemberId: value.trim() || null }) });
      await refreshUser();
      setSaved(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 480, marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Slack</h3>
      <ol className="muted small" style={{ paddingLeft: 18, marginTop: 0 }}>
        <li>{t("Отвори Slack → твоят профил → „⋯“ → „Copy member ID“.")}</li>
        <li>{t("Постави го тук и натисни Запази:")}</li>
      </ol>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="U0123ABCD" style={{ flex: 1 }} />
        <button onClick={save} disabled={saving}>
          {saving ? t("Запазване…") : t("Запази")}
        </button>
      </div>
      {saved && <p className="small" style={{ color: "var(--success, #1a7f37)", marginTop: 8 }}>✓ {t("Запазено")}</p>}
    </div>
  );
}

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

      <TelegramCard />
      <SlackCard />
    </div>
  );
}
