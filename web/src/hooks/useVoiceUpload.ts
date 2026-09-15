import { useEffect, useRef, useState } from "react";
import { api, apiUpload } from "../api/client";
import type { VoiceJobStatus } from "../api/types";
import { useI18n } from "../i18n/I18nContext";

export type VoiceUploadOutcome =
  | { kind: "sync"; transcriptId: string; draftsCreated: number }
  | { kind: "job"; status: VoiceJobStatus; errorMessage: string | null }
  | { kind: "error"; message: string };

/**
 * Shared submit->poll->outcome flow for anything that ends up POSTing an
 * audio File to /voice/transcribe — used by both the upload/record page and
 * the in-app meeting recorder, so the two don't drift on retry/poll timing.
 */
export function useVoiceUpload() {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<VoiceUploadOutcome | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

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

  async function submit(file: File, source: "upload" | "dictation" | "meet" = "upload") {
    setBusy(true);
    setOutcome(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("source", source);
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

  return { busy, outcome, submit };
}
