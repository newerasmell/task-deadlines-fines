import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { PRIORITY_LABELS } from "../api/types";
import type { Priority, SuggestedAssignee, User, VoiceDraftStatus, VoiceTaskDraft, VoiceTranscript } from "../api/types";
import { useI18n } from "../i18n/I18nContext";

const STATUS_LABELS: Record<VoiceDraftStatus, string> = {
  DRAFT: "Чернова",
  APPROVED: "Възложена",
  REJECTED: "Отхвърлена",
};

const SOURCE_LABELS: Record<string, string> = {
  UPLOAD: "Качен файл",
  // Covers both the Google Meet Drive auto-pull and a manually recorded
  // in-app meeting (Jitsi) — same source tag, either way it came from a call.
  MEET: "Среща (запис)",
  DICTATION: "Диктовка",
};

// Color-codes priority so a long stack of draft cards can be scanned at a
// glance instead of reading every "Приоритет: ..." line individually.
const PRIORITY_BADGE_CLASS: Record<Priority, string> = {
  LOW: "badge",
  MEDIUM: "badge badge-info",
  HIGH: "badge badge-warning",
  CRITICAL: "badge badge-danger",
};

const PRIORITY_BAR_COLOR: Record<Priority, string> = {
  LOW: "var(--border)",
  MEDIUM: "#3b82f6",
  HIGH: "var(--warning-border)",
  CRITICAL: "var(--danger)",
};

interface RecentTranscript extends VoiceTranscript {
  _count: { drafts: number };
}

export function VoiceReview() {
  const { t } = useI18n();
  const [status, setStatus] = useState<VoiceDraftStatus>("DRAFT");
  const [drafts, setDrafts] = useState<VoiceTaskDraft[]>([]);
  const [employees, setEmployees] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedTranscript, setExpandedTranscript] = useState<string | null>(null);
  const [transcriptText, setTranscriptText] = useState<Record<string, VoiceTranscript>>({});
  // The drafts-grouped list below has nothing to show for a recording that
  // extracted zero tasks — this is the only way to see what Whisper
  // actually heard in that case, to tell "bad audio" from "Claude found
  // nothing actionable" apart.
  const [recentTranscripts, setRecentTranscripts] = useState<RecentTranscript[]>([]);
  const [showRecent, setShowRecent] = useState(false);

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

  async function refreshRecentTranscripts() {
    setRecentTranscripts(await api<RecentTranscript[]>("/voice/transcripts?limit=20"));
  }

  useEffect(() => {
    refreshRecentTranscripts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Meet auto-import never re-downloads a Drive file it already has a
  // transcript row for — deleting that row here is how to clear one that
  // came from a broken run so the next sync picks the file up again.
  async function deleteTranscript(id: string) {
    if (!window.confirm(t("Изтрий този транскрипт? При следваща синхронизация записът ще се обработи наново."))) return;
    await api(`/voice/transcripts/${id}`, { method: "DELETE" });
    setExpandedTranscript((cur) => (cur === id ? null : cur));
    refreshRecentTranscripts();
  }

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

  const [reextracting, setReextracting] = useState<string | null>(null);

  async function reextractTranscript(id: string) {
    setReextracting(id);
    try {
      const res = await api<{ ok: true; draftsCreated: number }>(`/voice/transcripts/${id}/reextract`, { method: "POST" });
      window.alert(t("Намерени {n} задачи.", { n: String(res.draftsCreated) }));
      await Promise.all([refresh(), refreshRecentTranscripts()]);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : t("Грешка при преизвличането."));
    } finally {
      setReextracting(null);
    }
  }

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
      <div className="tabs" style={{ marginBottom: 16 }}>
        {(["DRAFT", "APPROVED", "REJECTED"] as VoiceDraftStatus[]).map((s) => (
          <button key={s} className={s === status ? "active" : ""} onClick={() => setStatus(s)}>
            {t(STATUS_LABELS[s])}
          </button>
        ))}
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <button className="small-btn secondary" onClick={() => setShowRecent((s) => !s)}>
          {showRecent ? t("Скрий последните разговори") : t("Покажи последните разговори (вкл. без намерени задачи)")}
        </button>
        {showRecent && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
            {recentTranscripts.length === 0 && <p className="muted small">{t("Няма разговори още.")}</p>}
            {recentTranscripts.map((tr) => (
              <div key={tr.id} style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className="badge badge-info">{t(SOURCE_LABELS[tr.source] ?? tr.source)}</span>
                  <span className="muted small">{new Date(tr.createdAt).toLocaleString()}</span>
                  <span className={tr._count.drafts > 0 ? "badge badge-success" : "badge"}>
                    {t("{n} задачи", { n: String(tr._count.drafts) })}
                  </span>
                  <button className="small-btn secondary" onClick={() => toggleTranscript(tr.id)}>
                    {expandedTranscript === tr.id ? t("Скрий транскрипта") : t("Покажи транскрипта")}
                  </button>
                  <button
                    className="small-btn secondary"
                    disabled={reextracting === tr.id}
                    onClick={() => reextractTranscript(tr.id)}
                    title={t("Пуска Claude отново върху вече записания транскрипт — не пипа звука, само търси задачи наново.")}
                  >
                    {reextracting === tr.id ? t("Преизвличам…") : t("Преизвлечи задачите")}
                  </button>
                  {tr.source === "MEET" && (
                    <button className="small-btn secondary" onClick={() => deleteTranscript(tr.id)} title={t("Изтрий, за да се обработи наново при следваща синхронизация")}>
                      {t("Изтрий")}
                    </button>
                  )}
                </div>
                {expandedTranscript === tr.id && (
                  <p
                    className="muted small"
                    style={{ whiteSpace: "pre-wrap", background: "var(--bg)", padding: 10, borderRadius: 6, marginTop: 8 }}
                  >
                    {transcriptText[tr.id]
                      ? transcriptText[tr.id].transcriptText || t("(празен транскрипт — Whisper не е разпознал говор)")
                      : t("Зареждане…")}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {groups.length === 0 && <p className="muted">{t("Няма чернови тук.")}</p>}

      {groups.map(([transcriptId, items]) => (
        <div key={transcriptId} className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="badge badge-info">{t(SOURCE_LABELS[items[0].transcript?.source ?? "UPLOAD"])}</span>
              <span className="muted small">
                {items[0].transcript ? new Date(items[0].transcript.createdAt).toLocaleString() : ""}
                {items[0].transcript?.originalFilename ? ` — ${items[0].transcript.originalFilename}` : ""}
              </span>
              {items[0].transcriptId && (
                <button className="small-btn secondary" onClick={() => toggleTranscript(items[0].transcriptId)}>
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
            <p className="muted small" style={{ whiteSpace: "pre-wrap", background: "var(--bg)", padding: 10, borderRadius: 6, marginTop: 12 }}>
              {transcriptText[items[0].transcriptId]?.transcriptText ?? t("Зареждане…")}
            </p>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
            {partitionChains(items.filter((d) => d.taskType !== "ai_opportunity")).map((entry) =>
              entry.kind === "chain" ? (
                <ChainCard key={entry.chainGroupId} steps={entry.steps} employees={employees} readOnly={status !== "DRAFT"} onChanged={refresh} />
              ) : (
                <DraftCard key={entry.draft.id} draft={entry.draft} employees={employees} readOnly={status !== "DRAFT"} onChanged={refresh} />
              )
            )}
          </div>

          {items.some((d) => d.taskType === "ai_opportunity") && (
            <div style={{ marginTop: 20 }}>
              <h3 className="muted small" style={{ margin: "0 0 10px", textTransform: "uppercase", letterSpacing: 0.5 }}>
                {t("Предложения от AI")}
              </h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {items
                  .filter((d) => d.taskType === "ai_opportunity")
                  .map((draft) => (
                    <DraftCard key={draft.id} draft={draft} employees={employees} readOnly={status !== "DRAFT"} onChanged={refresh} />
                  ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

type PartitionedEntry = { kind: "single"; draft: VoiceTaskDraft } | { kind: "chain"; chainGroupId: string; steps: VoiceTaskDraft[] };

// Splits one transcript's drafts into ordinary standalone items and
// chain groups (drafts sharing a chainGroupId, sorted by chainOrder) — a
// chain renders as one combined ChainCard instead of N separate DraftCards,
// since its steps can only be approved together as a single Project.
function partitionChains(items: VoiceTaskDraft[]): PartitionedEntry[] {
  const chainMap = new Map<string, VoiceTaskDraft[]>();
  const singles: VoiceTaskDraft[] = [];
  for (const d of items) {
    if (d.chainGroupId) {
      if (!chainMap.has(d.chainGroupId)) chainMap.set(d.chainGroupId, []);
      chainMap.get(d.chainGroupId)!.push(d);
    } else {
      singles.push(d);
    }
  }
  const chains: PartitionedEntry[] = Array.from(chainMap.entries()).map(([chainGroupId, steps]) => ({
    kind: "chain",
    chainGroupId,
    steps: [...steps].sort((a, b) => (a.chainOrder ?? 0) - (b.chainOrder ?? 0)),
  }));
  return [...chains, ...singles.map((draft): PartitionedEntry => ({ kind: "single", draft }))];
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
  const isOpportunity = draft.taskType === "ai_opportunity";
  const suggestions = useMemo<SuggestedAssignee[]>(() => {
    if (!draft.suggestedAssignees) return [];
    try {
      return JSON.parse(draft.suggestedAssignees) as SuggestedAssignee[];
    } catch {
      return [];
    }
  }, [draft.suggestedAssignees]);

  const [title, setTitle] = useState(draft.title);
  const [description, setDescription] = useState(draft.description ?? "");
  const [definitionOfDone, setDefinitionOfDone] = useState(draft.definitionOfDone ?? "");
  const [dodEdited, setDodEdited] = useState(false);
  const [assigneeId, setAssigneeId] = useState(draft.resolvedAssigneeId ?? suggestions[0]?.id ?? "");
  // True only while the current assigneeId is still just Claude's guess,
  // never explicitly confirmed — any interaction with the dropdown clears
  // it, even picking the same person again, per the brief's rule.
  const [assigneeIsSuggestion, setAssigneeIsSuggestion] = useState(!draft.resolvedAssigneeId && suggestions.length > 0);
  const [ownerId, setOwnerId] = useState(draft.resolvedOwnerId ?? "");
  const [deadline, setDeadline] = useState(draft.deadline.slice(0, 10));
  // Pre-filled from the browser's own local rendering of draft.deadline —
  // same assumption the rest of this page already makes (e.g. the
  // toLocaleDateString() badges below) that the browser's zone matches the
  // team's, so this lines up with whatever hour resolveDeadline picked.
  const [deadlineTime, setDeadlineTime] = useState(() => {
    const d = new Date(draft.deadline);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  });
  const [priority, setPriority] = useState<Priority>(draft.priority);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function pickAssignee(id: string) {
    setAssigneeId(id);
    setAssigneeIsSuggestion(false);
  }

  async function approve() {
    if (!assigneeId) {
      setError(t("Избери изпълнител, преди да одобриш."));
      return;
    }
    if (!definitionOfDone.trim()) {
      setError(t("Определението за завършена задача е задължително, преди да одобриш."));
      return;
    }
    if (ownerId && ownerId === assigneeId) {
      setError(t("Owner-ът не може да е самият изпълнител"));
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
          definitionOfDone,
          assigneeId,
          ownerId: ownerId || null,
          // A full local datetime string (not just the date) — the server
          // only defaults an unstated deadline to a fixed hour when it gets
          // a bare date, so carrying the time explicitly is what makes this
          // form's own time field (and the AI-assumed one it starts from)
          // actually stick instead of silently landing elsewhere.
          deadline: `${deadline}T${deadlineTime}:00`,
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

  const dodIsAiSuggested = !dodEdited && draft.dodSource === "ai_suggested";

  return (
    <div
      className="card"
      style={{
        margin: 0,
        background: "var(--bg)",
        borderLeft: `4px solid ${PRIORITY_BAR_COLOR[draft.priority]}`,
        ...(isOpportunity ? { border: "1px dashed var(--border)", borderLeftWidth: 4 } : {}),
      }}
    >
      {isOpportunity && (
        <span className="badge badge-info" style={{ marginBottom: 10, display: "inline-block" }}>
          {t("AI предложение")}
        </span>
      )}
      <p className="muted small" style={{ margin: "0 0 10px", fontWeight: 600 }}>
        {t("Извлечено от разговора")}:
      </p>
      <blockquote className="muted small" style={{ borderLeft: "3px solid var(--border)", paddingLeft: 10, margin: "0 0 14px" }}>
        “{draft.sourceQuote}”
      </blockquote>

      {readOnly ? (
        <div>
          <strong>{draft.title}</strong>
          {draft.description && <p className="muted small" style={{ margin: "4px 0 10px" }}>{draft.description}</p>}
          {draft.definitionOfDone && (
            <p className="muted small" style={{ margin: "4px 0 10px" }}>
              <strong>{t("Определение за завършена задача")}:</strong> {draft.definitionOfDone}
            </p>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            <span className="badge">
              {draft.resolvedAssignee?.name ?? t("Неопределен")}
            </span>
            {draft.resolvedOwner && (
              <span className="badge badge-info">{t("Owner: {name}", { name: draft.resolvedOwner.name })}</span>
            )}
            <span className="badge">{new Date(draft.deadline).toLocaleString()}</span>
            {draft.deadlineTimeAssumed && (
              <span className="badge badge-warning" title={t("Часът не е споменат в разговора — по подразбиране")}>
                {t("часът е по подразбиране")}
              </span>
            )}
            <span className={PRIORITY_BADGE_CLASS[draft.priority]}>{t(PRIORITY_LABELS[draft.priority])}</span>
          </div>
        </div>
      ) : (
        <div className="form">
          <label>
            {t("Заглавие")}
            <input value={title} onChange={(e) => setTitle(e.target.value)} disabled={submitting} />
          </label>
          <label>
            {t("Описание")}
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={submitting} rows={2} />
          </label>
          <label>
            {t("Определение за завършена задача")}
            {dodIsAiSuggested && (
              <span className="badge badge-info" style={{ marginLeft: 8 }}>
                {t("AI предложение")}
              </span>
            )}
            <textarea
              value={definitionOfDone}
              onChange={(e) => {
                setDefinitionOfDone(e.target.value);
                setDodEdited(true);
              }}
              disabled={submitting}
              rows={2}
              required
            />
          </label>
          <div className="form-row">
            <label>
              {t("Изпълнител")}
              {assigneeIsSuggestion && (
                <span className="badge badge-info" style={{ marginLeft: 8 }}>
                  {t("AI предложение")}
                </span>
              )}
              <select value={assigneeId} onChange={(e) => pickAssignee(e.target.value)} disabled={submitting}>
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
            <label>
              {t("Срок")}
              <div style={{ display: "flex", gap: 6 }}>
                <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} disabled={submitting} style={{ flex: 1 }} />
                <input
                  type="time"
                  value={deadlineTime}
                  onChange={(e) => setDeadlineTime(e.target.value)}
                  disabled={submitting}
                  style={{ width: 100 }}
                />
              </div>
              {draft.deadlineTimeAssumed && (
                <span className="badge badge-warning" style={{ marginTop: 4, alignSelf: "flex-start" }}>
                  {t("Часът не е споменат в разговора — {h} е по подразбиране, провери/промени", { h: deadlineTime })}
                </span>
              )}
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
          {suggestions.length > 0 && (
            <div className="muted small" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontWeight: 600 }}>{t("Предложения от AI:")}</span>
              {suggestions.map((s) => (
                <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" className="small-btn secondary" disabled={submitting} onClick={() => pickAssignee(s.id)}>
                    {s.name}
                  </button>
                  <span>{s.reason}</span>
                </div>
              ))}
            </div>
          )}
          <label>
            {t("Owner (по избор — само ако разговорът изрично спомене преглеждащ)")}
            <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} disabled={submitting}>
              <option value="">{t("— Без Owner —")}</option>
              {employees
                .filter((e) => e.active && e.id !== assigneeId)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
            </select>
          </label>
          {error && <div className="error-text small">{error}</div>}
          <div className="form-row" style={{ marginTop: 4 }}>
            <button onClick={approve} disabled={submitting}>
              {t("Одобри")}
            </button>
            <button className="secondary" onClick={reject} disabled={submitting}>
              {t("Отхвърли")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface ChainStepDraft {
  draftId: string;
  title: string;
  description: string;
  definitionOfDone: string;
  assigneeId: string;
  ownerId: string;
  priority: Priority;
  deadline: string; // step 0 only
  delayDays: string; // steps 1+ only
}

function ChainCard({
  steps,
  employees,
  readOnly,
  onChanged,
}: {
  steps: VoiceTaskDraft[];
  employees: User[];
  readOnly: boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [projectTitle, setProjectTitle] = useState(steps[0]?.chainTitle || steps[0]?.title || "");
  const [stepDrafts, setStepDrafts] = useState<ChainStepDraft[]>(() =>
    steps.map((s) => ({
      draftId: s.id,
      title: s.title,
      description: s.description ?? "",
      definitionOfDone: s.definitionOfDone ?? "",
      assigneeId: s.resolvedAssigneeId ?? "",
      ownerId: "",
      priority: s.priority,
      deadline: s.deadline.slice(0, 10),
      delayDays: s.delayDaysAfterPrevious ? String(s.delayDaysAfterPrevious) : "",
    }))
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function updateStep(index: number, patch: Partial<ChainStepDraft>) {
    setStepDrafts((cur) => cur.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  async function approveChain() {
    for (let i = 0; i < stepDrafts.length; i++) {
      const s = stepDrafts[i];
      if (!s.assigneeId) return setError(t("Избери изпълнител за стъпка {n}.", { n: i + 1 }));
      if (!s.definitionOfDone.trim()) return setError(t("Въведи определение за завършена задача за стъпка {n}.", { n: i + 1 }));
      if (i === 0 && !s.deadline) return setError(t("Първата стъпка трябва да има краен срок."));
      if (i > 0 && !s.delayDays) return setError(t("Стъпка {n} трябва да има брой дни след предходната.", { n: i + 1 }));
    }
    setError(null);
    setSubmitting(true);
    try {
      await api(`/voice/chains/${steps[0].chainGroupId}/approve`, {
        method: "POST",
        body: JSON.stringify({
          projectTitle,
          steps: stepDrafts.map((s, i) => ({
            draftId: s.draftId,
            title: s.title,
            description: s.description || null,
            definitionOfDone: s.definitionOfDone,
            assigneeId: s.assigneeId,
            ownerId: s.ownerId || null,
            priority: s.priority,
            deadline: i === 0 ? s.deadline : undefined,
            delayDays: i > 0 ? Number(s.delayDays) : undefined,
          })),
        }),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  async function rejectChain() {
    if (!window.confirm(t('Наистина ли да отхвърля цялата верига "{title}" ({n} стъпки)?', { title: projectTitle, n: steps.length }))) return;
    setSubmitting(true);
    try {
      await Promise.all(steps.map((s) => api(`/voice/drafts/${s.id}/reject`, { method: "POST" })));
      onChanged();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card" style={{ margin: 0, background: "var(--bg)", borderLeft: "4px solid var(--primary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span className="badge badge-info">🔗 {t("Сложна задача")}</span>
        <span className="muted small">{t("{n} стъпки", { n: steps.length })}</span>
      </div>

      {readOnly ? (
        <div>
          <strong>{projectTitle}</strong>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
            {steps.map((s, i) => (
              <div key={s.id} className="card" style={{ margin: 0, padding: "10px 14px" }}>
                <blockquote className="muted small" style={{ borderLeft: "3px solid var(--border)", paddingLeft: 10, margin: "0 0 8px" }}>
                  “{s.sourceQuote}”
                </blockquote>
                <strong>
                  {i + 1}. {s.title}
                </strong>
                {s.description && <p className="muted small" style={{ margin: "4px 0" }}>{s.description}</p>}
                {s.definitionOfDone && (
                  <p className="muted small" style={{ margin: "4px 0" }}>
                    <strong>{t("Определение за завършена задача")}:</strong> {s.definitionOfDone}
                  </p>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                  <span className="badge">{s.resolvedAssignee?.name ?? t("Неопределен")}</span>
                  <span className="badge">
                    {i === 0
                      ? new Date(s.deadline).toLocaleDateString()
                      : t("{n} дни след предходната", { n: s.delayDaysAfterPrevious ?? "?" })}
                  </span>
                  <span className={PRIORITY_BADGE_CLASS[s.priority]}>{t(PRIORITY_LABELS[s.priority])}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="form">
          <label>
            {t("Име на проекта")}
            <input value={projectTitle} onChange={(e) => setProjectTitle(e.target.value)} disabled={submitting} />
          </label>

          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 6 }}>
            {steps.map((s, i) => {
              const step = stepDrafts[i];
              return (
                <div key={s.id} className="card" style={{ margin: 0 }}>
                  <blockquote className="muted small" style={{ borderLeft: "3px solid var(--border)", paddingLeft: 10, margin: "0 0 10px" }}>
                    “{s.sourceQuote}”
                  </blockquote>
                  <strong className="small">{t("Стъпка {n}", { n: i + 1 })}</strong>
                  <label style={{ marginTop: 6 }}>
                    {t("Заглавие")}
                    <input value={step.title} onChange={(e) => updateStep(i, { title: e.target.value })} disabled={submitting} />
                  </label>
                  <label>
                    {t("Описание")}
                    <textarea value={step.description} onChange={(e) => updateStep(i, { description: e.target.value })} disabled={submitting} rows={2} />
                  </label>
                  <label>
                    {t("Определение за завършена задача")}
                    <textarea
                      value={step.definitionOfDone}
                      onChange={(e) => updateStep(i, { definitionOfDone: e.target.value })}
                      disabled={submitting}
                      rows={2}
                      required
                    />
                  </label>
                  <div className="form-row">
                    <label>
                      {t("Изпълнител")}
                      <select value={step.assigneeId} onChange={(e) => updateStep(i, { assigneeId: e.target.value })} disabled={submitting}>
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
                    {i === 0 ? (
                      <label>
                        {t("Срок")}
                        <input type="date" value={step.deadline} onChange={(e) => updateStep(i, { deadline: e.target.value })} disabled={submitting} />
                      </label>
                    ) : (
                      <label>
                        {t("Дни след предходната стъпка")}
                        <input
                          type="number"
                          min={1}
                          max={90}
                          value={step.delayDays}
                          onChange={(e) => updateStep(i, { delayDays: e.target.value })}
                          disabled={submitting}
                        />
                      </label>
                    )}
                    <label>
                      {t("Приоритет")}
                      <select value={step.priority} onChange={(e) => updateStep(i, { priority: e.target.value as Priority })} disabled={submitting}>
                        {(Object.keys(PRIORITY_LABELS) as Priority[]).map((p) => (
                          <option key={p} value={p}>
                            {t(PRIORITY_LABELS[p])}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label>
                    {t("Owner (по избор — задължителен само ако изпълнителят е самият теб)")}
                    <select value={step.ownerId} onChange={(e) => updateStep(i, { ownerId: e.target.value })} disabled={submitting}>
                      <option value="">{t("— Без Owner —")}</option>
                      {employees
                        .filter((e) => e.active && e.id !== step.assigneeId)
                        .map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
              );
            })}
          </div>

          {error && <div className="error-text small" style={{ marginTop: 10 }}>{error}</div>}
          <div className="form-row" style={{ marginTop: 10 }}>
            <button onClick={approveChain} disabled={submitting}>
              {t("Одобри веригата")}
            </button>
            <button className="secondary" onClick={rejectChain} disabled={submitting}>
              {t("Отхвърли веригата")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
