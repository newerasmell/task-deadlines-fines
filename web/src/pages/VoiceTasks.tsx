import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, apiUpload } from "../api/client";
import { VOICE_JOB_STATUS_LABELS } from "../api/types";
import type { GoogleMeetStatus, VoiceJobStatus } from "../api/types";
import { useI18n } from "../i18n/I18nContext";

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

  async function syncNow() {
    setSyncing(true);
    setError(null);
    try {
      await api("/voice/meet/poll-now", { method: "POST" });
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
      <div className="card" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Google Meet</h3>
        <p className="muted small">
          {t(
            "Не е конфигуриран — за автоматично внасяне на записи от Google Meet трябва да зададеш GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET и GOOGLE_REFRESH_TOKEN."
          )}
        </p>
      </div>
    );
  }

  const result = status.lastResult;

  return (
    <div className="card" style={{ marginBottom: 16, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Google Meet</h3>
        <button onClick={syncNow} disabled={syncing || status.inProgress}>
          {syncing || status.inProgress ? t("Синхронизира се…") : t("Синхронизирай сега")}
        </button>
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
            ? t("Намерени: {seen}, обработени: {processed}, пропуснати: {skipped}", {
                seen: result.seen,
                processed: result.processed,
                skipped: result.skipped,
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

type Outcome =
  | { kind: "sync"; transcriptId: string; draftsCreated: number }
  | { kind: "job"; status: VoiceJobStatus; errorMessage: string | null }
  | { kind: "error"; message: string };

export function VoiceTasks() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [micError, setMicError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  async function startRecording() {
    setMicError(null);
    setOutcome(null);
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

  async function submit(file: File) {
    setBusy(true);
    setOutcome(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("source", "upload");
      const res = await apiUpload<
        | { ok: true; sync: true; transcriptId: string; draftsCreated: number }
        | { ok: true; sync: false; jobId: string }
      >("/voice/transcribe", form);

      if (res.sync) {
        setOutcome({ kind: "sync", transcriptId: res.transcriptId, draftsCreated: res.draftsCreated });
      } else {
        setOutcome({ kind: "job", status: "PENDING", errorMessage: null });
        pollJob(res.jobId);
      }
    } catch (err) {
      setOutcome({ kind: "error", message: err instanceof Error ? err.message : t("Грешка при разпознаване — опитай отново.") });
    } finally {
      setBusy(false);
    }
  }

  function pollJob(jobId: string) {
    pollRef.current = setTimeout(async () => {
      try {
        const job = await api<{ status: VoiceJobStatus; errorMessage: string | null }>(`/voice/jobs/${jobId}`);
        if (job.status === "DONE" || job.status === "FAILED") {
          setOutcome({ kind: "job", status: job.status, errorMessage: job.errorMessage });
          return;
        }
        setOutcome({ kind: "job", status: job.status, errorMessage: null });
        pollJob(jobId);
      } catch (err) {
        setOutcome({ kind: "error", message: err instanceof Error ? err.message : t("Грешка при проверка на статуса.") });
      }
    }, 4000);
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t("Задачи от разговор")}</h1>
      </div>
      <p className="muted">
        {t(
          "Качи запис или го направи направо тук — системата ще го разпознае и ще извлече задачите като чернови за одобрение."
        )}
      </p>

      <GoogleMeetPanel />

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {!recording ? (
            <button onClick={startRecording} disabled={busy}>
              🎙️ {t("Запиши")}
            </button>
          ) : (
            <button style={{ background: "#e53935" }} onClick={stopRecording}>
              ⏹ {t("Спри")} ({recordSeconds}s)
            </button>
          )}
          {recording && (
            <span className="small" style={{ color: "#e53935", fontWeight: 600 }}>
              ● {t("Записва се…")}
            </span>
          )}
        </div>
        {micError && <div className="error-text">{micError}</div>}

        <div>
          <label className="muted small" style={{ display: "block", marginBottom: 4 }}>
            {t("...или качи файл (mp3, m4a, wav, webm, ogg)")}
          </label>
          <input type="file" accept=".mp3,.m4a,.wav,.webm,.ogg,audio/*" onChange={handleFile} disabled={busy || recording} />
        </div>

        {busy && <p className="muted small">{t("Качване…")}</p>}

        {outcome?.kind === "sync" && (
          <div className="small">
            ✓ {t("Готово — открити {n} задача/и.", { n: outcome.draftsCreated })}{" "}
            <button className="link-btn" onClick={() => navigate("/voice-review")}>
              {t("Прегледай чернови →")}
            </button>
          </div>
        )}
        {outcome?.kind === "job" && (
          <div className="small">
            {outcome.status === "FAILED" ? (
              <span className="error-text">
                ✕ {t("Грешка при разпознаване — опитай отново.")} {outcome.errorMessage}
              </span>
            ) : outcome.status === "DONE" ? (
              <>
                ✓ {t("Готово.")}{" "}
                <button className="link-btn" onClick={() => navigate("/voice-review")}>
                  {t("Прегледай чернови →")}
                </button>
              </>
            ) : (
              t(VOICE_JOB_STATUS_LABELS[outcome.status])
            )}
          </div>
        )}
        {outcome?.kind === "error" && <div className="error-text small">✕ {outcome.message}</div>}
      </div>
    </div>
  );
}
