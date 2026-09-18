import { randomUUID } from "crypto";
import { prisma } from "../lib/prisma";
import { ExtractionParseError, ExtractedTask, extractTasks, priorityToTaskPriority, resolveDeadline } from "../lib/taskExtraction";
import { estimateWhisperCostUsd, transcribeAudio } from "../lib/whisper";

export type VoiceSource = "UPLOAD" | "MEET" | "DICTATION";

export interface TranscribeInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  source: VoiceSource;
  createdById: string | null;
  meetRecordingId?: string | null;
  // Meet auto-generates its own transcript Doc alongside the recording —
  // when that text is already in hand, skip Whisper entirely rather than
  // re-transcribing audio that's already been transcribed once for free.
  pregivenTranscriptText?: string | null;
  // Multi-segment in-app meeting recording (see Meeting.tsx): a long
  // recording is rotated client-side into sub-25MB chunks sharing this id,
  // each uploaded as its own request rather than one file that would blow
  // past Whisper's hard 25MB cap. isFinalSegment marks the last one, which
  // is when extraction actually runs (see POST /voice/transcribe).
  meetingSessionId?: string | null;
  isFinalSegment?: boolean;
}

export async function transcribeAndStore(input: TranscribeInput): Promise<string> {
  const result = input.pregivenTranscriptText
    ? { text: input.pregivenTranscriptText, language: undefined, durationSeconds: undefined }
    : await transcribeAudio(input.buffer, input.filename, input.mimeType);

  if (input.meetingSessionId) {
    const existing = await prisma.voiceTranscript.findUnique({ where: { meetingSessionId: input.meetingSessionId } });
    if (existing) {
      const updated = await prisma.voiceTranscript.update({
        where: { id: existing.id },
        data: {
          transcriptText: `${existing.transcriptText}\n${result.text}`,
          durationSeconds: (existing.durationSeconds ?? 0) + (result.durationSeconds ?? 0),
          whisperCostUsd: (existing.whisperCostUsd ?? 0) + (estimateWhisperCostUsd(result.durationSeconds) ?? 0),
        },
      });
      return updated.id;
    }
  }

  const transcript = await prisma.voiceTranscript.create({
    data: {
      source: input.source,
      originalFilename: input.filename,
      meetRecordingId: input.meetRecordingId ?? null,
      meetingSessionId: input.meetingSessionId ?? null,
      transcriptText: result.text,
      durationSeconds: result.durationSeconds ?? null,
      languageDetected: result.language ?? null,
      createdById: input.createdById,
      whisperCostUsd: input.pregivenTranscriptText ? null : estimateWhisperCostUsd(result.durationSeconds),
    },
  });
  return transcript.id;
}

interface ChainAssignment {
  chainGroupId: string;
  chainOrder: number;
  delayDaysAfterPrevious: number | null;
  chainTitle: string | null;
}

// Claude marks chain membership with a small integer scoped to this one
// extraction call (see the "СЛОЖНИ ЗАДАЧИ" prompt section) — this turns
// that into real per-draft chain fields: a generated (not model-provided)
// group id so two separate extraction runs can never collide, a 1-based
// order within the group, and a chain of exactly one item (the model
// flagged a dependency but nothing else shares its number) demoted back to
// a standalone draft, since a "chain" of one step isn't one.
function assignChainGroups(tasks: ExtractedTask[]): (ChainAssignment | null)[] {
  const counts = new Map<number, number>();
  for (const t of tasks) {
    if (t.chain_group != null) counts.set(t.chain_group, (counts.get(t.chain_group) ?? 0) + 1);
  }

  const groupIdByRaw = new Map<number, string>();
  const nextOrderByRaw = new Map<number, number>();

  return tasks.map((t) => {
    if (t.chain_group == null || (counts.get(t.chain_group) ?? 0) < 2) return null;

    if (!groupIdByRaw.has(t.chain_group)) {
      groupIdByRaw.set(t.chain_group, randomUUID());
      nextOrderByRaw.set(t.chain_group, 1);
    }
    const order = nextOrderByRaw.get(t.chain_group)!;
    nextOrderByRaw.set(t.chain_group, order + 1);

    return {
      chainGroupId: groupIdByRaw.get(t.chain_group)!,
      chainOrder: order,
      delayDaysAfterPrevious: order > 1 ? (t.delay_days_after_previous ?? 1) : null,
      chainTitle: order === 1 ? t.chain_title?.trim() || t.title : null,
    };
  });
}

// Confirms an extracted assignee_id (or owner_id) is actually a real,
// still-active user — Claude was given the live roster and told to echo
// back one of those ids verbatim, but never trust that blindly (a stale/
// hallucinated id, or the literal "unassigned", both just leave the field
// unset for the admin to pick on the review screen; never blocks draft
// creation either way).
async function resolveAssignee(id: string | null | undefined): Promise<string | null> {
  if (!id || id === "unassigned") return null;
  const user = await prisma.user.findFirst({ where: { id, active: true } });
  return user?.id ?? null;
}

// Validates Claude's 1-2 candidate guesses (only ever present when
// assignee_id came back "unassigned") against real active users the same
// way resolveAssignee does, dropping any stale/hallucinated id rather than
// showing the admin a suggestion pointing at nobody. Returns a JSON string
// for VoiceTaskDraft.suggestedAssignees (null if nothing survived), with
// each user's name embedded so the review screen never needs a second
// lookup just to render a suggestion.
async function resolveSuggestedAssignees(
  raw: ExtractedTask["suggested_assignees"]
): Promise<string | null> {
  if (!raw || raw.length === 0) return null;
  const resolved: { id: string; name: string; reason: string }[] = [];
  for (const s of raw) {
    const user = await prisma.user.findFirst({ where: { id: s.assignee_id, active: true }, select: { id: true, name: true } });
    if (user) resolved.push({ id: user.id, name: user.name, reason: s.reason });
  }
  return resolved.length > 0 ? JSON.stringify(resolved) : null;
}

/**
 * Runs Claude extraction on an already-stored transcript and creates one
 * VoiceTaskDraft per extracted task — never a real Task (see the brief's
 * "no task is ever created directly as assigned" rule). Lets
 * ExtractionParseError propagate as-is so the caller decides how to surface
 * the raw model output.
 */
export async function extractAndCreateDrafts(transcriptId: string): Promise<number> {
  const transcript = await prisma.voiceTranscript.findUniqueOrThrow({ where: { id: transcriptId } });
  // A silent/near-empty recording (Whisper heard no speech) leaves
  // transcriptText empty — Claude's API rejects an empty user message
  // outright, so there's nothing to extract from and no point asking.
  if (!transcript.transcriptText.trim()) return 0;
  const extraction = await extractTasks(transcript.transcriptText);

  await prisma.voiceTranscript.update({
    where: { id: transcriptId },
    data: { claudeInputTokens: extraction.inputTokens, claudeOutputTokens: extraction.outputTokens },
  });

  const chainAssignments = assignChainGroups(extraction.tasks);

  let created = 0;
  for (let i = 0; i < extraction.tasks.length; i++) {
    const item = extraction.tasks[i];
    const chain = chainAssignments[i];
    const resolvedAssigneeId = await resolveAssignee(item.assignee_id);
    // A resolved owner is never allowed to equal the resolved assignee
    // (same rule POST /voice/drafts/:id/approve enforces) — if Claude ever
    // slips and names the same person for both, drop the owner rather than
    // create a draft the admin can't approve as-is.
    const resolvedOwnerIdRaw = await resolveAssignee(item.owner_id);
    const resolvedOwnerId = resolvedOwnerIdRaw && resolvedOwnerIdRaw !== resolvedAssigneeId ? resolvedOwnerIdRaw : null;
    // Suggestions only make sense when nothing was actually resolved — if
    // assignee_id somehow did resolve, the admin already has a real pick,
    // so don't also show a "guess" alongside it.
    const suggestedAssignees = resolvedAssigneeId ? null : await resolveSuggestedAssignees(item.suggested_assignees);
    const { date: deadline, timeWasAssumed: deadlineTimeAssumed } = resolveDeadline(item.deadline, item.deadline_time);
    await prisma.voiceTaskDraft.create({
      data: {
        transcriptId,
        title: item.title.slice(0, 200),
        description: item.description ?? null,
        definitionOfDone: item.definition_of_done,
        dodSource: item.dod_source,
        taskType: item.task_type,
        assigneeKey: item.assignee_id,
        resolvedAssigneeId,
        suggestedAssignees,
        ownerKey: item.owner_id ?? null,
        resolvedOwnerId,
        deadline,
        deadlineTimeAssumed,
        priority: priorityToTaskPriority(item.priority),
        sourceQuote: item.source_quote,
        createdByAi: true,
        chainGroupId: chain?.chainGroupId ?? null,
        chainOrder: chain?.chainOrder ?? null,
        delayDaysAfterPrevious: chain?.delayDaysAfterPrevious ?? null,
        chainTitle: chain?.chainTitle ?? null,
      },
    });
    created++;
  }
  return created;
}

function errorMessageFor(err: unknown): string {
  if (err instanceof ExtractionParseError) {
    return `${err.message} Суров отговор от модела: ${err.rawText.slice(0, 1000)}`;
  }
  return err instanceof Error ? err.message : "Неизвестна грешка";
}

/**
 * The background path for a longer recording: transcribe → extract →
 * create drafts, tracked via a VoiceProcessingJob row the frontend polls.
 * Never throws — every failure is recorded on the job row itself, since
 * nothing is awaiting this call directly (see POST /voice/transcribe).
 */
export async function processJobInBackground(jobId: string, input: TranscribeInput): Promise<void> {
  try {
    await prisma.voiceProcessingJob.update({ where: { id: jobId }, data: { status: "TRANSCRIBING" } });
    const transcriptId = await transcribeAndStore(input);
    await prisma.voiceProcessingJob.update({ where: { id: jobId }, data: { status: "EXTRACTING", transcriptId } });
    // A non-final segment of a multi-part meeting recording is transcribed
    // and appended, but extraction only runs once, on the final segment —
    // Claude needs the whole conversation, not a fragment of it.
    if (!input.meetingSessionId || input.isFinalSegment) {
      await extractAndCreateDrafts(transcriptId);
    }
    await prisma.voiceProcessingJob.update({ where: { id: jobId }, data: { status: "DONE" } });
  } catch (err) {
    await prisma.voiceProcessingJob
      .update({ where: { id: jobId }, data: { status: "FAILED", errorMessage: errorMessageFor(err) } })
      .catch((updateErr) => console.error(`[voiceProcessing] failed to record job failure for ${jobId}:`, updateErr));
  }
}

export { errorMessageFor };
