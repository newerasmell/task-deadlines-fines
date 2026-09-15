import { prisma } from "../lib/prisma";
import { ExtractionParseError, extractTasks, priorityToTaskPriority, resolveDeadline } from "../lib/taskExtraction";
import { estimateWhisperCostUsd, transcribeAudio } from "../lib/whisper";

export type VoiceSource = "UPLOAD" | "MEET" | "DICTATION";

export interface TranscribeInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  source: VoiceSource;
  createdById: string | null;
  meetRecordingId?: string | null;
}

export async function transcribeAndStore(input: TranscribeInput): Promise<string> {
  const result = await transcribeAudio(input.buffer, input.filename, input.mimeType);
  const transcript = await prisma.voiceTranscript.create({
    data: {
      source: input.source,
      originalFilename: input.filename,
      meetRecordingId: input.meetRecordingId ?? null,
      transcriptText: result.text,
      durationSeconds: result.durationSeconds ?? null,
      languageDetected: result.language ?? null,
      createdById: input.createdById,
      whisperCostUsd: estimateWhisperCostUsd(result.durationSeconds),
    },
  });
  return transcript.id;
}

// Confirms an extracted assignee_id is actually a real, still-active user —
// Claude was given the live roster and told to echo back one of those ids
// verbatim, but never trust that blindly (a stale/hallucinated id, or the
// literal "unassigned", both just leave the draft unassigned for the admin
// to pick on the review screen; never blocks draft creation either way).
async function resolveAssignee(id: string | null | undefined): Promise<string | null> {
  if (!id || id === "unassigned") return null;
  const user = await prisma.user.findFirst({ where: { id, active: true } });
  return user?.id ?? null;
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
  const extraction = await extractTasks(transcript.transcriptText);

  await prisma.voiceTranscript.update({
    where: { id: transcriptId },
    data: { claudeInputTokens: extraction.inputTokens, claudeOutputTokens: extraction.outputTokens },
  });

  let created = 0;
  for (const item of extraction.tasks) {
    const resolvedAssigneeId = await resolveAssignee(item.assignee_id);
    await prisma.voiceTaskDraft.create({
      data: {
        transcriptId,
        title: item.title.slice(0, 200),
        description: item.description ?? null,
        assigneeKey: item.assignee_id,
        resolvedAssigneeId,
        deadline: resolveDeadline(item.deadline),
        priority: priorityToTaskPriority(item.priority),
        sourceQuote: item.source_quote,
        createdByAi: true,
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
    await extractAndCreateDrafts(transcriptId);
    await prisma.voiceProcessingJob.update({ where: { id: jobId }, data: { status: "DONE" } });
  } catch (err) {
    await prisma.voiceProcessingJob
      .update({ where: { id: jobId }, data: { status: "FAILED", errorMessage: errorMessageFor(err) } })
      .catch((updateErr) => console.error(`[voiceProcessing] failed to record job failure for ${jobId}:`, updateErr));
  }
}

export { errorMessageFor };
