import { useNavigate } from "react-router-dom";
import { VOICE_JOB_STATUS_LABELS } from "../api/types";
import type { VoiceUploadOutcome } from "../hooks/useVoiceUpload";
import { useI18n } from "../i18n/I18nContext";

export function VoiceOutcome({ outcome }: { outcome: VoiceUploadOutcome | null }) {
  const { t } = useI18n();
  const navigate = useNavigate();

  if (!outcome) return null;

  if (outcome.kind === "sync") {
    return (
      <div className="small">
        ✓ {t("Готово — открити {n} задача/и.", { n: outcome.draftsCreated })}{" "}
        <button className="link-btn" onClick={() => navigate("/voice-review")}>
          {t("Прегледай чернови →")}
        </button>
      </div>
    );
  }

  if (outcome.kind === "job") {
    if (outcome.status === "FAILED") {
      return (
        <div className="small">
          <span className="error-text">
            ✕ {t("Грешка при разпознаване — опитай отново.")} {outcome.errorMessage}
          </span>
        </div>
      );
    }
    if (outcome.status === "DONE") {
      return (
        <div className="small">
          ✓ {t("Готово.")}{" "}
          <button className="link-btn" onClick={() => navigate("/voice-review")}>
            {t("Прегледай чернови →")}
          </button>
        </div>
      );
    }
    return <div className="small">{t(VOICE_JOB_STATUS_LABELS[outcome.status])}</div>;
  }

  return <div className="error-text small">✕ {outcome.message}</div>;
}
