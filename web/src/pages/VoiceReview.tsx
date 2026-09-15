import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { PRIORITY_LABELS } from "../api/types";
import type { Priority, User, VoiceDraftStatus, VoiceTaskDraft, VoiceTranscript } from "../api/types";
import { useI18n } from "../i18n/I18nContext";

const STATUS_LABELS: Record<VoiceDraftStatus, string> = {
  DRAFT: "Чернова",
  APPROVED: "Възложена",
  REJECTED: "Отхвърлена",
};

const SOURCE_LABELS: Record<string, string> = {
  UPLOAD: "Качен файл",
  MEET: "Google Meet",
  DICTATION: "Диктовка",
};

export function VoiceReview() {
  const { t } = useI18n();
  const [status, setStatus] = useState<VoiceDraftStatus>("DRAFT");
  const [drafts, setDrafts] = useState<VoiceTaskDraft[]>([]);
  const [employees, setEmployees] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedTranscript, setExpandedTranscript] = useState<string | null>(null);
  const [transcriptText, setTranscriptText] = useState<Record<string, VoiceTranscript>>({});

  async function refresh() {
    setDrafts(await api<VoiceTaskDraft[]>(`/voice/drafts?status=${status}`));
  }

  useEffect(() => {
    setLoading(true);
    Promise.all([refresh(), employees.length ? Promise.resolve() : api<User[]>("/users").then(setEmployees)]).finally(() =>
      setLoading(false)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function toggleTranscript(id: string | null) {
    if (!id) return;
    if (expandedTranscript === id) {
      setExpandedTranscript(null);
      return;
    }
    setExpandedTranscript(id);
    if (!transcriptText[id]) {
      const full = await api<VoiceTranscript>(`/voice/transcripts/${id}`);
      setTranscriptText((cur) => ({ ...cur, [id]: full }));
    }
  }

  const groups = useMemo(() => {
    const byTranscript = new Map<string, VoiceTaskDraft[]>();
    for (const d of drafts) {
      const key = d.transcriptId ?? "manual";
      if (!byTranscript.has(key)) byTranscript.set(key, []);
      byTranscript.get(key)!.push(d);
    }
    return Array.from(byTranscript.entries());
  }, [drafts]);

  async function approveAll(transcriptId: string) {
    const res = await api<{ approved: number; skipped: { title: string; reason: string }[] }>(
      `/voice/transcripts/${transcriptId}/approve-all`,
      { method: "POST" }
    );
    if (res.skipped.length > 0) {
      window.alert(
        t("Одобрени: {n}. Пропуснати (одобри ги поотделно): {list}", {
          n: res.approved,
          list: res.skipped.map((s) => `"${s.title}" — ${s.reason}`).join("; "),
        })
      );
    }
    refresh();
  }

  if (loading) return <p>{t("Зареждане…")}</p>;

  return (
    <div>
      <div className="page-header">
        <h1>{t("Чакащи одобрение")}</h1>
      </div>
      <div className="form-row" style={{ marginBottom: 12 }}>
        {(["DRAFT", "APPROVED", "REJECTED"] as VoiceDraftStatus[]).map((s) => (
          <button key={s} className={s === status ? "" : "secondary"} onClick={() => setStatus(s)}>
            {t(STATUS_LABELS[s])}
          </button>
        ))}
      </div>

      {groups.length === 0 && <p className="muted">{t("Няма чернови тук.")}</p>}

      {groups.map(([transcriptId, items]) => (
        <div key={transcriptId} className="card" style={{ marginBottom: 16 }}>
          <div className="form-row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <strong>{t(SOURCE_LABELS[items[0].transcript?.source ?? "UPLOAD"])}</strong>{" "}
              <span className="muted small">
                {items[0].transcript ? new Date(items[0].transcript.createdAt).toLocaleString() : ""}
                {items[0].transcript?.originalFilename ? ` — ${items[0].transcript.originalFilename}` : ""}
              </span>
              {items[0].transcriptId && (
                <button className="link-btn small" onClick={() => toggleTranscript(items[0].transcriptId)}>
                  {expandedTranscript === items[0].transcriptId ? t("Скрий транскрипта") : t("Покажи транскрипта")}
                </button>
              )}
            </div>
            {status === "DRAFT" && (
              <button className="secondary" onClick={() => approveAll(transcriptId)}>
                {t("Одобри всички")}
              </button>
            )}
          </div>
          {expandedTranscript === items[0].transcriptId && items[0].transcriptId && (
            <p className="muted small" style={{ whiteSpace: "pre-wrap", background: "var(--bg)", padding: 8, borderRadius: 6 }}>
              {transcriptText[items[0].transcriptId]?.transcriptText ?? t("Зареждане…")}
            </p>
          )}

          {items.map((draft) => (
            <DraftCard key={draft.id} draft={draft} employees={employees} readOnly={status !== "DRAFT"} onChanged={refresh} />
          ))}
        </div>
      ))}
    </div>
  );
}

function DraftCard({
  draft,
  employees,
  readOnly,
  onChanged,
}: {
  draft: VoiceTaskDraft;
  employees: User[];
  readOnly: boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(draft.title);
  const [description, setDescription] = useState(draft.description ?? "");
  const [assigneeId, setAssigneeId] = useState(draft.resolvedAssigneeId ?? "");
  const [deadline, setDeadline] = useState(draft.deadline.slice(0, 10));
  const [priority, setPriority] = useState<Priority>(draft.priority);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function approve() {
    if (!assigneeId) {
      setError(t("Избери изпълнител, преди да одобриш."));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await api(`/voice/drafts/${draft.id}/approve`, {
        method: "POST",
        body: JSON.stringify({
          title,
          description: description || null,
          assigneeId,
          deadline,
          priority,
        }),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  async function reject() {
    if (!window.confirm(t('Наистина ли да отхвърля "{title}"?', { title: draft.title }))) return;
    setSubmitting(true);
    try {
      await api(`/voice/drafts/${draft.id}/reject`, { method: "POST" });
      onChanged();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 10, background: "var(--bg)" }}>
      <blockquote className="muted small" style={{ borderLeft: "3px solid #ccc", paddingLeft: 10, margin: "0 0 10px" }}>
        “{draft.sourceQuote}”
      </blockquote>
      {readOnly ? (
        <div>
          <strong>{draft.title}</strong>
          {draft.description && <p className="muted small">{draft.description}</p>}
          <p className="small">
            {draft.resolvedAssignee?.name ?? t("Неопределен")} · {new Date(draft.deadline).toLocaleDateString()} ·{" "}
            {t(PRIORITY_LABELS[draft.priority])}
          </p>
        </div>
      ) : (
        <>
          <div className="form-row">
            <label>
              {t("Заглавие")}
              <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={submitting} />
            </label>
            <label>
              {t("Изпълнител")}
              <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} disabled={submitting}>
                <option value="">{t("— Избери —")}</option>
                {employees
                  .filter((e) => e.active)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <label>
            {t("Описание")}
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={submitting} rows={2} />
          </label>
          <div className="form-row">
            <label>
              {t("Срок")}
              <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} disabled={submitting} />
            </label>
            <label>
              {t("Приоритет")}
              <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} disabled={submitting}>
                {(Object.keys(PRIORITY_LABELS) as Priority[]).map((p) => (
                  <option key={p} value={p}>
                    {t(PRIORITY_LABELS[p])}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && <div className="error-text small">{error}</div>}
          <div className="form-row">
            <button onClick={approve} disabled={submitting}>
              {t("Одобри")}
            </button>
            <button className="secondary" onClick={reject} disabled={submitting}>
              {t("Отхвърли")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
