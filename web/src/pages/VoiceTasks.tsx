import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { api } from "../api/client";
import type { GoogleMeetStatus } from "../api/types";
import { VoiceOutcome } from "../components/VoiceOutcome";
import { IconGlobe, IconInbox, IconMic } from "../components/icons";
import { useVoiceUpload } from "../hooks/useVoiceUpload";
import { useI18n } from "../i18n/I18nContext";
import { formatDuration } from "../utils/format";

function GoogleMeetPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<GoogleMeetStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadStatus() {
    try {
      setStatus(await api<GoogleMeetStatus>("/voice/meet/status"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка при зареждане на статуса."));
    }
  }

  useEffect(() => {
    void loadStatus();
  }, []);

  async function syncNow(force = false) {
    setSyncing(true);
    setError(null);
    try {
      await api("/voice/meet/poll-now", { method: "POST", body: JSON.stringify({ force }) });
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка при синхронизация."));
    } finally {
      setSyncing(false);
    }
  }

  if (!status) return null;

  if (!status.configured) {
    return (
      <div className="card panel-row">
        <span className="badge">Google Meet</span>
        <p className="muted small" style={{ margin: 0 }}>
          {t(
            "Не е конфигуриран — за автоматично внасяне на записи от Google Meet трябва да зададеш GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET и GOOGLE_REFRESH_TOKEN."
          )}
        </p>
      </div>
    );
  }

  const result = status.lastResult;

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <span className="badge badge-info">Google Meet</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="small-btn secondary" onClick={() => syncNow(false)} disabled={syncing || status.inProgress}>
            {syncing || status.inProgress ? t("Синхронизира се…") : t("Синхронизирай сега")}
          </button>
          <button
            className="small-btn secondary"
            onClick={() => syncNow(true)}
            disabled={syncing || status.inProgress}
            title={t("Изтегля наново и презаписва вече обработени записи — за случай, че стар опит е взел лош/празен транскрипт")}
          >
            {t("Пресинхронизирай отначало")}
          </button>
        </div>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        {t("Папка в Drive")}: <strong>{status.folderName}</strong>
      </p>
      {status.lastRunAt && (
        <p className="muted small" style={{ margin: 0 }}>
          {t("Последна проверка")}: {new Date(status.lastRunAt).toLocaleString()}
        </p>
      )}
      {result && (
        <p className="small" style={{ margin: 0 }}>
          {result.folderFound
            ? t("Намерени: {seen}, обработени: {processed}, пропуснати: {skipped}, неуспешни: {failed}", {
                seen: result.seen,
                processed: result.processed,
                skipped: result.skipped,
                failed: result.failed,
              })
            : t("Папката не е намерена в Google Drive.")}
        </p>
      )}
      {(result?.lastError || error) && <div className="error-text small">✕ {result?.lastError ?? error}</div>}
    </div>
  );
}

// Tried in order — the browser picks the first it actually supports.
// Safari (desktop + iOS) never supports webm, only mp4/aac; Chrome is the
// opposite. Without this fallback chain, MediaRecorder just throws on
// whichever browser isn't the one it was tested on.
const CANDIDATE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];

function pickSupportedMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of CANDIDATE_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

export function VoiceTasks() {
  const { t } = useI18n();
  const { busy, outcome, submit } = useVoiceUpload();
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  async function startRecording() {
    setMicError(null);
    const mimeType = pickSupportedMimeType();
    if (!mimeType) {
      setMicError(t("Този браузър не поддържа запис на звук."));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const ext = mimeType.includes("mp4") ? "m4a" : mimeType.includes("aac") ? "aac" : "webm";
        void submit(new File([blob], `record-${Date.now()}.${ext}`, { type: mimeType }));
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      setMicError(t("Микрофонът е отказан или недостъпен — провери разрешенията на браузъра."));
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
  }

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await submit(file);
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t("Задачи от разговор")}</h1>
      </div>

      <GoogleMeetPanel />

      <div className="card hero-card">
        <div className="hero-icon">
          <IconMic size={26} />
        </div>
        <h2>{t("Запиши или качи разговор")}</h2>
        <p className="muted">
          {t(
            "Качи запис или го направи направо тук — системата ще го разпознае и ще извлече задачите като чернови за одобрение."
          )}
        </p>

        <div style={{ display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
          {!recording ? (
            <button className="cta" onClick={startRecording} disabled={busy}>
              🎙️ {t("Запиши")}
            </button>
          ) : (
            <button className="cta secondary" onClick={stopRecording}>
              ⏹ {t("Спри")} ({formatDuration(recordSeconds)})
            </button>
          )}
          <button className="cta secondary" onClick={() => fileInputRef.current?.click()} disabled={busy || recording}>
            📁 {t("Качи файл")}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".mp3,.m4a,.wav,.webm,.ogg,.mp4,.mpeg,audio/*,video/mp4,video/mpeg,video/webm"
            onChange={handleFile}
            disabled={busy || recording}
            style={{ display: "none" }}
          />
        </div>

        {recording && (
          <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
            <span className="recording-pill badge badge-danger">
              <span className="recording-dot" /> {t("Записва се…")}
            </span>
          </div>
        )}
        {micError && <div className="error-text small" style={{ marginTop: 12 }}>{micError}</div>}
        {busy && <p className="muted small" style={{ marginTop: 12 }}>{t("Качване…")}</p>}
        <VoiceOutcome outcome={outcome} />

        <div className="hero-features">
          <div className="hero-feature">
            <IconGlobe size={20} />
            {t("Поддържани формати: mp3, m4a, wav, webm, ogg")}
          </div>
          <div className="hero-feature">
            <IconInbox size={20} />
            {t("Черновите отиват в „Чакащи одобрение“")}
          </div>
        </div>
      </div>
    </div>
  );
}
