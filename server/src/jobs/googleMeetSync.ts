import { readFile, rm } from "fs/promises";
import path from "path";
import { prepareAudioChunks } from "../lib/audioChunking";
import { env } from "../lib/env";
import { downloadFileToTempFile, findMeetFolderId, isFolder, listFilesInFolder } from "../lib/googleDrive";
import type { DriveFile } from "../lib/googleDrive";
import { MAX_AUDIO_BYTES_LIMIT } from "../lib/voiceUploads";
import { prisma } from "../lib/prisma";
import { processJobInBackground, type TranscribeInput } from "../services/voiceProcessing";

export interface GoogleMeetSyncResult {
  folderFound: boolean;
  seen: number;
  processed: number;
  skipped: number;
  failed: number;
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
  // Streamed straight to disk, never buffered in memory — a 40+ minute Meet
  // recording is easily several hundred MB of raw video, and holding that
  // in one Buffer risked an OOM crash on Render before ffmpeg even got a
  // chance to shrink it down to just audio (confirmed live: syncs on real
  // longer recordings were taking the whole server down mid-request).
  const downloadedPath = await downloadFileToTempFile(file.id);
  try {
    // Always transcoded, even when already under the size cap: Whisper
    // determines the file format from the filename's extension, not the
    // multipart Content-Type — and Drive's own file.name for a Meet
    // recording usually has no extension at all (e.g. "kfs-iivr-ewa
    // (2026-09-18 11:14 GMT)"), which Whisper flatly rejects as
    // "Unrecognized file format" no matter what mimeType says. Every chunk
    // this produces gets a real ".mp3" name, sidestepping that entirely.
    const { paths: chunkPaths, cleanup: cleanupChunks } = await prepareAudioChunks(downloadedPath, MAX_AUDIO_BYTES_LIMIT);
    try {
      const sessionId = chunkPaths.length > 1 ? file.id : null;

      for (let i = 0; i < chunkPaths.length; i++) {
        // Read one chunk at a time (each already bounded to
        // MAX_AUDIO_BYTES_LIMIT) rather than all of them up front — a long
        // recording can produce several chunks, and there's no reason to
        // hold them all in memory simultaneously.
        const buffer = await readFile(chunkPaths[i]);
        const input: TranscribeInput = {
          buffer,
          filename: chunkPaths.length > 1 ? `${file.name} (${i + 1}/${chunkPaths.length}).mp3` : `${file.name}.mp3`,
          mimeType: "audio/mpeg",
          source: "MEET",
          createdById: null,
          // Only the first chunk tags the dedup key — later chunks are
          // folded into that same VoiceTranscript row by meetingSessionId
          // instead.
          meetRecordingId: i === 0 ? file.id : null,
          meetingSessionId: sessionId,
          isFinalSegment: i === chunkPaths.length - 1,
        };
        const job = await prisma.voiceProcessingJob.create({ data: { source: "MEET", status: "PENDING", createdById: null } });
        await processJobInBackground(job.id, input);
        // processJobInBackground catches its own errors and only ever
        // records them on the job row (see its own doc comment — nothing
        // else is awaiting it directly in the manual-upload path it was
        // written for), so a Whisper/Claude failure here would otherwise
        // vanish silently: "processed" would still count the file, but no
        // VoiceTranscript row — and no visible error anywhere — would
        // exist for it. Re-reading the job and re-throwing surfaces that
        // failure to the caller instead.
        const finished = await prisma.voiceProcessingJob.findUniqueOrThrow({ where: { id: job.id } });
        if (finished.status === "FAILED") {
          throw new Error(finished.errorMessage ?? `Неуспешна обработка на "${file.name}".`);
        }
      }
    } finally {
      await cleanupChunks();
    }
  } finally {
    await rm(path.dirname(downloadedPath), { recursive: true, force: true });
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
    return lastResult ?? { folderFound: false, seen: 0, processed: 0, skipped: 0, failed: 0, lastError: "Вече тече синхронизация" };
  }

  syncInProgress = true;
  const result: GoogleMeetSyncResult = { folderFound: false, seen: 0, processed: 0, skipped: 0, failed: 0, lastError: null };

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

      try {
        await processRecording(file);
        processedThisRun++;
        result.processed++;
      } catch (err) {
        // One bad recording (a Whisper/ffmpeg failure) shouldn't abort the
        // whole batch — note it and move on to the next file, same as a
        // routine skip, just with the reason visible instead of silent.
        result.failed++;
        result.lastError = `"${file.name}": ${err instanceof Error ? err.message : "Неизвестна грешка"}`;
        console.error(`[googleMeetSync] failed to process ${file.name}:`, err);
      }
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
