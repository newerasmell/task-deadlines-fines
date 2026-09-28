import { useI18n } from "../i18n/I18nContext";

// Always shown next to a task (list row, board card, info panel) so the icon
// itself never shifts layout — it just "lights up" (colored, glowing) when
// meetLink is set, and stays disabled/grey otherwise. Click opens the link
// in a new tab; the click never bubbles up into a row/card's own onClick
// (e.g. board card opens the edit form on click) since this is always
// wrapped in its own stopPropagation.
export function MeetLinkButton({ meetLink, compact = true }: { meetLink: string | null | undefined; compact?: boolean }) {
  const { t } = useI18n();
  const hasLink = Boolean(meetLink);

  return (
    <button
      type="button"
      className={`small-btn secondary meet-link-btn${hasLink ? " meet-link-btn-active" : ""}`}
      disabled={!hasLink}
      onClick={(e) => {
        e.stopPropagation();
        if (meetLink) window.open(meetLink, "_blank", "noopener");
      }}
      title={hasLink ? t("Отвори Google Meet") : t("Няма зададен Google Meet линк")}
    >
      {compact ? "🎥" : t("Google Meet")}
    </button>
  );
}
