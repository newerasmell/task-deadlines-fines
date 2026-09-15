import { useEffect, useRef, useState } from "react";
import { VoiceOutcome } from "../components/VoiceOutcome";
import { useVoiceUpload } from "../hooks/useVoiceUpload";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";

const JITSI_DOMAIN = "meet.jit.si";
const JITSI_SCRIPT_SRC = `https://${JITSI_DOMAIN}/external_api.js`;

// Same fallback chain as the upload/record page — MediaRecorder support for
// a given mimeType is browser-specific, not something to hardcode one of.
const CANDIDATE_MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac"];

function pickSupportedMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of CANDIDATE_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

function randomRoomName(): string {
  return `todf-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`;
}

// Loaded once and cached on window — re-injecting the script on every mount
// (e.g. leaving and returning to this page) would otherwise redefine the
// global JitsiMeetExternalAPI class repeatedly for no benefit.
let jitsiScriptPromise: Promise<void> | null = null;
function loadJitsiScript(): Promise<void> {
  if (window.JitsiMeetExternalAPI) return Promise.resolve();
  if (!jitsiScriptPromise) {
    jitsiScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = JITSI_SCRIPT_SRC;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Неуспешно зареждане на meet.jit.si"));
      document.body.appendChild(script);
    });
  }
  return jitsiScriptPromise;
}

declare global {
  interface Window {
    JitsiMeetExternalAPI?: new (domain: string, options: Record<string, unknown>) => JitsiEmbed;
  }
}

interface JitsiEmbed {
  dispose(): void;
  addListener(event: string, handler: (...args: unknown[]) => void): void;
}

export function Meeting() {
  const { t } = useI18n();
  const { user } = useAuth();
  const { busy, outcome, submit } = useVoiceUpload();

  const [scriptError, setScriptError] = useState<string | null>(null);
  const [roomName, setRoomName] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [recordError, setRecordError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const jitsiRef = useRef<JitsiEmbed | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      jitsiRef.current?.dispose();
      if (timerRef.current) clearInterval(timerRef.current);
      displayStreamRef.current?.getTracks().forEach((tr) => tr.stop());
    };
  }, []);

  async function startMeeting() {
    setScriptError(null);
    try {
      await loadJitsiScript();
    } catch (err) {
      setScriptError(err instanceof Error ? err.message : t("Неуспешно зареждане на meet.jit.si"));
      return;
    }
    // The script tag can report success (onload fires) while an ad-blocker
    // or privacy extension quietly swaps in an empty response instead of a
    // real network error — window.JitsiMeetExternalAPI never gets defined
    // in that case, so this must surface its own error rather than no-op.
    if (!window.JitsiMeetExternalAPI) {
      setScriptError(
        t(
          "meet.jit.si се зареди, но не предостави нужния API — вероятно блокиран от ad-blocker/разширение за поверителност. Пробвай да го изключиш за този сайт или отвори в друг браузър."
        )
      );
      return;
    }
    if (!containerRef.current) return;

    const room = randomRoomName();
    jitsiRef.current?.dispose();
    jitsiRef.current = new window.JitsiMeetExternalAPI(JITSI_DOMAIN, {
      roomName: room,
      parentNode: containerRef.current,
      width: "100%",
      height: 480,
      userInfo: user ? { displayName: user.name } : undefined,
      configOverwrite: { prejoinPageEnabled: false },
    });
    setRoomName(room);
  }

  function endMeeting() {
    jitsiRef.current?.dispose();
    jitsiRef.current = null;
    setRoomName(null);
    if (recording) stopRecording();
  }

  // Captures this BROWSER TAB's audio output (everyone on the call, since
  // Jitsi plays through this same tab) rather than just the mic — the user
  // must pick "This Tab" / "Chrome Tab" and tick "Share tab audio" in the
  // native browser prompt; there's no way to preselect that for them.
  async function startRecording() {
    setRecordError(null);
    const mimeType = pickSupportedMimeType();
    if (!mimeType) {
      setRecordError(t("Този браузър не поддържа запис на звук."));
      return;
    }
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const audioTracks = displayStream.getAudioTracks();
      if (audioTracks.length === 0) {
        displayStream.getTracks().forEach((tr) => tr.stop());
        setRecordError(t('Няма избран звук — при споделянето трябва да отбележиш "Share tab audio" / "Споделяне на звук".'));
        return;
      }
      displayStream.getVideoTracks().forEach((tr) => tr.stop()); // video only needed for the picker, discard it
      displayStreamRef.current = displayStream;

      const audioOnlyStream = new MediaStream(audioTracks);
      const recorder = new MediaRecorder(audioOnlyStream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        displayStreamRef.current?.getTracks().forEach((tr) => tr.stop());
        displayStreamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const ext = mimeType.includes("mp4") ? "m4a" : mimeType.includes("aac") ? "aac" : "webm";
        void submit(new File([blob], `meeting-${Date.now()}.${ext}`, { type: mimeType }), "meet");
      };
      // If the user stops sharing from the browser's own "Stop sharing" bar
      // instead of our button, treat that the same as clicking "Спри".
      audioTracks[0].addEventListener("ended", () => stopRecording());

      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setRecordSeconds(0);
      timerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      setRecordError(t("Споделянето на таба е отказано или недостъпно."));
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t("Среща")}</h1>
      </div>
      <p className="muted">
        {t(
          "Започни видео среща направо тук (Jitsi, безплатно, не изисква акаунт) и по желание запиши разговора за автоматично извличане на задачи."
        )}
      </p>

      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {!roomName && (
          <div>
            <button onClick={startMeeting}>{t("Започни среща")}</button>
            {scriptError && <div className="error-text small" style={{ marginTop: 8 }}>{scriptError}</div>}
          </div>
        )}

        {roomName && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <p className="muted small" style={{ margin: 0 }}>
              {t("Покани колеги с връзка")}:{" "}
              <code>{`https://${JITSI_DOMAIN}/${roomName}`}</code>
            </p>
            <button style={{ background: "#e53935" }} onClick={endMeeting}>
              {t("Приключи срещата")}
            </button>
          </div>
        )}

        {/* Always mounted (not just once roomName is set) — startMeeting()
            needs this container to already exist in the DOM before it can
            create the embed and set roomName, so it can't be conditional on
            roomName itself without a chicken-and-egg deadlock. */}
        <div ref={containerRef} style={{ borderRadius: 8, overflow: "hidden", display: roomName ? "block" : "none" }} />

        {roomName && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              {!recording ? (
                <button onClick={startRecording} disabled={busy}>
                  ⏺ {t("Запиши разговора")}
                </button>
              ) : (
                <button style={{ background: "#e53935" }} onClick={stopRecording}>
                  ⏹ {t("Спри записа")} ({recordSeconds}s)
                </button>
              )}
              {recording && (
                <span className="small" style={{ color: "#e53935", fontWeight: 600 }}>
                  ● {t("Записва се…")}
                </span>
              )}
            </div>
            <p className="muted small" style={{ margin: 0 }}>
              {t(
                'При натискане на "Запиши разговора" браузърът ще поиска да избереш кой таб да споделиш — избери ТОЗИ таб и отбележи "Share tab audio" / "Споделяне на звук", за да се запишат всички участници, не само твоят микрофон.'
              )}
            </p>
            {recordError && <div className="error-text small">{recordError}</div>}
          </>
        )}

        {busy && <p className="muted small">{t("Качване…")}</p>}
        <VoiceOutcome outcome={outcome} />
      </div>
    </div>
  );
}
