import { prepareAudioChunks } from "../lib/audioChunking";
import { env } from "../lib/env";
import { downloadFileBuffer, findMeetFolderId, isFolder, listFilesInFolder } from "../lib/googleDrive";
import type { DriveFile } from "../lib/googleDrive";
import { MAX_AUDIO_BYTES_LIMIT } from "../lib/voiceUploads";
import { prisma } from "../lib/prisma";
import { processJobInBackground, type TranscribeInput } from "../services/voiceProcessing";

export interface GoogleMeetSyncResult {
  folderFound: boolean;
  seen: number;
  processed: number;
  skipped: number;
  lastError: string | null;
}

let syncInProgress = false;
let lastResult: GoogleMeetSyncResult | null = null;
let lastRunAt: Date | null = null;

export function getLastGoogleMeetSyncResult(): { result: GoogleMeetSyncResult | null; ranAt: Date | null; inProgress: boolean } {
  return { result: lastResult, ranAt: lastRunAt, inProgress: syncInProgress };
}

// A per-meeting Drive subfolder can hold several files (the raw recording,
// plus Meet/Gemini's own auto-generated Docs) — only the raw recording is
// used. Meet/Gemini's own transcription is unreliable for Bulgarian (it can
// come back empty even when the recording has plenty of real speech in it),
// so those Docs are never read at all; Whisper, run ourselves on the actual
// recording, is what handles Bulgarian correctly.
function pickRecordingFile(files: DriveFile[]): DriveFile | null {
  return files.find((f) => f.mimeType.startsWith("audio/") || f.mimeType.startsWith("video/")) ?? null;
}

// A recording straight from Drive can be well over Whisper's hard per-file
// cap (it's raw video, not something already compressed down to just
// audio) — prepareAudioChunks transcodes it down and, if it's still too
// big, splits it into several chunks. Each chunk is transcribed and
// appended as its own VoiceProcessingJob sharing one meetingSessionId (the
// same mechanism Meeting.tsx's client-side chunked in-app recording already
// uses — see transcribeAndStore), with extraction running once, after the
// last chunk.
async function processRecording(file: DriveFile): Promise<void> {
  const buffer = await downloadFileBuffer(file.id);
  const chunks = buffer.length > MAX_AUDIO_BYTES_LIMIT ? await prepareAudioChunks(buffer, MAX_AUDIO_BYTES_LIMIT) : [buffer];
  const sessionId = chunks.length > 1 ? file.id : null;

  for (let i = 0; i < chunks.length; i++) {
    const input: TranscribeInput = {
      buffer: chunks[i],
      filename: chunks.length > 1 ? `${file.name} (${i + 1}/${chunks.length}).mp3` : file.name,
      mimeType: chunks.length > 1 ? "audio/mpeg" : file.mimeType,
      source: "MEET",
      createdById: null,
      // Only the first chunk tags the dedup key — later chunks are folded
      // into that same VoiceTranscript row by meetingSessionId instead.
      meetRecordingId: i === 0 ? file.id : null,
      meetingSessionId: sessionId,
      isFinalSegment: i === chunks.length - 1,
    };
    const job = await prisma.voiceProcessingJob.create({ data: { source: "MEET", status: "PENDING", createdById: null } });
    await processJobInBackground(job.id, input);
  }
}

/**
 * Polls the configured Drive folder for new Meet recordings not yet
 * imported (dedup via VoiceTranscript.meetRecordingId), and runs each one
 * through the same transcribe→extract→draft pipeline uploads use.
 * Sequential and awaited per file — this already runs inside a background
 * cron tick, so there's no caller left waiting on it, and running Whisper/
 * Claude calls one at a time avoids bursting rate limits on a backlog.
 *
 * `force` (only ever passed from the manual "Sync now" action, never the
 * routine cron tick) re-downloads and re-transcribes every recording found,
 * discarding whatever VoiceTranscript row already exists for it first —
 * the escape hatch for a recording that was already (mis-)imported by an
 * older, buggier version of this sync, which dedup would otherwise hide
 * from every future sync forever.
 */
export async function runGoogleMeetSync(force = false): Promise<GoogleMeetSyncResult> {
  if (syncInProgress) {
    return lastResult ?? { folderFound: false, seen: 0, processed: 0, skipped: 0, lastError: "Вече тече синхронизация" };
  }

  syncInProgress = true;
  const result: GoogleMeetSyncResult = { folderFound: false, seen: 0, processed: 0, skipped: 0, lastError: null };

  try {
    const folderId = await findMeetFolderId();
    if (!folderId) {
      result.lastError = `Папка "${env.googleMeetFolderName}" не е намерена в Google Drive.`;
      return result;
    }
    result.folderFound = true;

    // Google Meet nests each recording under its own per-meeting subfolder
    // (named after the meeting code, e.g. "kfs-iivr-ewa - <timestamp>")
    // rather than dropping files directly into the configured folder, so one
    // level of folders needs expanding into their actual contents — picking
    // just the recording file per subfolder (see pickRecordingFile), not
    // every file inside it.
    const topLevel = await listFilesInFolder(folderId, env.googleMeetMaxPerPoll * 3);
    const files: DriveFile[] = [];
    for (const item of topLevel) {
      if (isFolder(item.mimeType)) {
        const recording = pickRecordingFile(await listFilesInFolder(item.id, 20));
        if (recording) files.push(recording);
      } else if (item.mimeType.startsWith("audio/") || item.mimeType.startsWith("video/")) {
        files.push(item);
      }
    }
    result.seen = files.length;

    let processedThisRun = 0;
    for (const file of files) {
      if (processedThisRun >= env.googleMeetMaxPerPoll) break;

      const already = await prisma.voiceTranscript.findUnique({ where: { meetRecordingId: file.id } });
      if (already) {
        if (!force) {
          result.skipped++;
          continue;
        }
        await prisma.voiceTranscript.delete({ where: { id: already.id } });
      }

      await processRecording(file);
      processedThisRun++;
      result.processed++;
    }
  } catch (err) {
    result.lastError = err instanceof Error ? err.message : "Неизвестна грешка";
    console.error("[googleMeetSync] sync failed:", err);
  } finally {
    syncInProgress = false;
    lastResult = result;
    lastRunAt = new Date();
  }

  return result;
}
