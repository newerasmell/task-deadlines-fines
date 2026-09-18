import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import type { Task } from "../api/types";
import { useI18n } from "../i18n/I18nContext";

const AFTERNOON_HOUR = 14;
const MORNING_HOUR = 9; // "Утре сутрин" / "N дни преди срока" default start hour
const DAYS_BEFORE_DEADLINE_OPTIONS = [1, 2, 3, 5, 7];

interface WhenOption {
  key: string;
  label: string;
  date: Date;
}

function atHour(base: Date, hour: number): Date {
  const d = new Date(base);
  d.setHours(hour, 0, 0, 0);
  return d;
}

function computeWhenOptions(deadline: Date, now: Date, t: (s: string, p?: Record<string, string | number>) => string): WhenOption[] {
  const options: WhenOption[] = [];

  const todayAfternoon = atHour(now, AFTERNOON_HOUR);
  if (now < todayAfternoon) {
    options.push({ key: "afternoon", label: t("Днес следобед"), date: todayAfternoon });
  } else {
    options.push({ key: "now", label: t("Сега"), date: now });
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  options.push({ key: "tomorrow", label: t("Утре сутрин ({h}:00)", { h: MORNING_HOUR }), date: atHour(tomorrow, MORNING_HOUR) });

  for (const n of DAYS_BEFORE_DEADLINE_OPTIONS) {
    const d = new Date(deadline);
    d.setDate(d.getDate() - n);
    const candidate = atHour(d, MORNING_HOUR);
    if (candidate > now) {
      options.push({ key: `before-${n}`, label: t("{n} дни преди срока", { n }), date: candidate });
    }
  }

  const deadlineDay = atHour(deadline, MORNING_HOUR);
  if (deadlineDay > now) {
    options.push({ key: "deadline-day", label: t("В деня на срока"), date: deadlineDay });
  }

  return options;
}

const DURATION_OPTIONS: { key: string; label: string; minutes: number | "allDay" }[] = [
  { key: "30m", label: "30 мин", minutes: 30 },
  { key: "1h", label: "1ч", minutes: 60 },
  { key: "2h", label: "2ч", minutes: 120 },
  { key: "allDay", label: "Цял ден", minutes: "allDay" },
];

// Full-control fallback: opens Google Calendar's own event editor in a new
// tab, prefilled from the task, instead of going through our own push
// endpoint at all — per the brief's "Друго" chip.
function openInGoogleCalendar(task: Task) {
  const start = new Date(task.deadline);
  start.setDate(start.getDate() - 1);
  start.setHours(MORNING_HOUR, 0, 0, 0);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: task.title,
    details: task.description ?? "",
    dates: `${fmt(start)}/${fmt(end)}`,
  });
  window.open(`https://calendar.google.com/calendar/render?${params.toString()}`, "_blank", "noopener");
}

interface Position {
  top?: number;
  bottom?: number;
  right: number;
}

export function PushToCalendarButton({
  task,
  googleConnected,
  onUpdated,
  compact,
}: {
  task: Task;
  googleConnected: boolean;
  onUpdated: (task: Task) => void;
  // Icon-only trigger (for tight spaces like the list-view actions column) —
  // same popover, just a narrower button so it doesn't overflow its grid
  // column and bleed into the neighboring cell.
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);
  const [selectedWhen, setSelectedWhen] = useState<WhenOption | null>(null);
  const [selectedDuration, setSelectedDuration] = useState<number | "allDay" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const whenOptions = computeWhenOptions(new Date(task.deadline), new Date(), t);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const estimatedHeight = 260;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUpward = spaceBelow < estimatedHeight && rect.top > estimatedHeight;
    setPos({
      right: window.innerWidth - rect.right,
      ...(openUpward ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function openPopover() {
    if (!googleConnected) return;
    // Pre-mark the existing choice when editing an already-pushed task, per
    // the brief — best-effort match against the current chip set (a custom
    // "Друго" pick won't match any chip, and that's fine, it just opens
    // with nothing pre-selected).
    if (task.pushedStart) {
      const pushedTime = new Date(task.pushedStart).getTime();
      const match = whenOptions.find((o) => o.date.getTime() === pushedTime);
      setSelectedWhen(match ?? null);
      setSelectedDuration(task.pushedDurationMinutes === 1440 ? "allDay" : task.pushedDurationMinutes ?? null);
    } else {
      setSelectedWhen(null);
      setSelectedDuration(null);
    }
    setOpen(true);
  }

  async function submit() {
    if (!selectedWhen || selectedDuration === null) return;
    setSubmitting(true);
    try {
      const body =
        selectedDuration === "allDay"
          ? { start: selectedWhen.date.toISOString(), allDay: true }
          : { start: selectedWhen.date.toISOString(), durationMinutes: selectedDuration };
      const updated = await api<Task>(`/tasks/${task.id}/push-to-calendar`, { method: "POST", body: JSON.stringify(body) });
      onUpdated(updated);
      setOpen(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      const updated = await api<Task>(`/tasks/${task.id}/push-to-calendar`, { method: "DELETE" });
      onUpdated(updated);
    } finally {
      setRemoving(false);
    }
  }

  if (task.googleEventId && task.pushedStart) {
    const pushedLabel = t("В календара: {date}", { date: new Date(task.pushedStart).toLocaleString() });
    return (
      <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <button
          ref={triggerRef}
          type="button"
          className="small-btn secondary"
          onClick={openPopover}
          disabled={!googleConnected}
          title={compact ? pushedLabel : undefined}
        >
          {compact ? "📅" : pushedLabel}
        </button>
        <button type="button" className="small-btn secondary" onClick={remove} disabled={removing} title={t("Премахни от календара")}>
          ✕
        </button>
        {open &&
          pos &&
          createPortal(
            <PopoverContent
              dropdownRef={dropdownRef}
              pos={pos}
              task={task}
              whenOptions={whenOptions}
              selectedWhen={selectedWhen}
              setSelectedWhen={setSelectedWhen}
              selectedDuration={selectedDuration}
              setSelectedDuration={setSelectedDuration}
              submit={submit}
              submitting={submitting}
              close={() => setOpen(false)}
            />,
            document.body
          )}
      </div>
    );
  }

  return (
    <div style={{ display: "inline-block" }}>
      <button
        ref={triggerRef}
        type="button"
        className="small-btn secondary"
        onClick={openPopover}
        disabled={!googleConnected}
        title={googleConnected ? (compact ? t("Push to Calendar") : undefined) : t('Свържи Google Calendar от профила си')}
      >
        {compact ? "📅" : t("Push to Calendar")}
      </button>
      {open &&
        pos &&
        createPortal(
          <PopoverContent
            dropdownRef={dropdownRef}
            pos={pos}
            task={task}
            whenOptions={whenOptions}
            selectedWhen={selectedWhen}
            setSelectedWhen={setSelectedWhen}
            selectedDuration={selectedDuration}
            setSelectedDuration={setSelectedDuration}
            submit={submit}
            submitting={submitting}
            close={() => setOpen(false)}
          />,
          document.body
        )}
    </div>
  );
}

function PopoverContent({
  dropdownRef,
  pos,
  task,
  whenOptions,
  selectedWhen,
  setSelectedWhen,
  selectedDuration,
  setSelectedDuration,
  submit,
  submitting,
  close,
}: {
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  pos: Position;
  task: Task;
  whenOptions: WhenOption[];
  selectedWhen: WhenOption | null;
  setSelectedWhen: (o: WhenOption) => void;
  selectedDuration: number | "allDay" | null;
  setSelectedDuration: (d: number | "allDay") => void;
  submit: () => void;
  submitting: boolean;
  close: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      ref={dropdownRef}
      className="card push-calendar-popover"
      style={{ position: "fixed", top: pos.top, bottom: pos.bottom, right: pos.right, width: 320, zIndex: 50 }}
    >
      <div className="small muted" style={{ marginBottom: 6 }}>
        {t("Кога да започнеш")}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {whenOptions.map((o) => (
          <button
            key={o.key}
            type="button"
            className={`chip${selectedWhen?.key === o.key ? " chip-selected" : ""}`}
            onClick={() => setSelectedWhen(o)}
          >
            {o.label}
          </button>
        ))}
        <button
          type="button"
          className="chip"
          onClick={() => {
            openInGoogleCalendar(task);
            close();
          }}
        >
          {t("Друго…")}
        </button>
      </div>

      <div className="small muted" style={{ marginBottom: 6 }}>
        {t("За колко време")}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {DURATION_OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            className={`chip${selectedDuration === o.minutes ? " chip-selected" : ""}`}
            onClick={() => setSelectedDuration(o.minutes)}
          >
            {o.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        onClick={submit}
        disabled={!selectedWhen || selectedDuration === null || submitting}
        style={{ width: "100%" }}
      >
        {submitting ? t("Изпращане…") : t("Изпрати в календара")}
      </button>
    </div>
  );
}
