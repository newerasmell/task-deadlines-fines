import { env } from "../lib/env";
import { downloadFileBuffer, exportDocTranscriptText, findMeetFolderId, isFolder, isGoogleDoc, listFilesInFolder } from "../lib/googleDrive";
import type { DriveFile } from "../lib/googleDrive";
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

// A per-meeting Drive subfolder can hold several files (the raw recording
// plus a Meet/Gemini Doc — see exportDocTranscriptText for why that Doc's
// "Transcript" tab, not its "Notes" tab, is what's actually read). Processing
// every file in the subfolder as its own independent "meeting" both wastes
// Whisper/Claude calls and risks extracting nothing from the one that
// matters, so exactly one representative file is picked per subfolder.
//
// The raw recording comes first: Meet/Gemini's own built-in transcription
// (both the "Notes" AI summary and, it turns out, the "Transcript" tab's
// actual speech-to-text) is unreliable for Bulgarian — it can come back
// empty even when the recording has plenty of real Bulgarian speech in it.
// Whisper handles Bulgarian properly, so the recording (transcribed by us)
// is preferred whenever it's present; the Doc is only a fallback for the
// rare case where no recording file exists in the folder.
function pickBestMeetingFile(files: DriveFile[]): DriveFile | null {
  return (
    files.find((f) => f.mimeType.startsWith("audio/") || f.mimeType.startsWith("video/")) ??
    files.find((f) => isGoogleDoc(f.mimeType)) ??
    files.find((f) => f.mimeType === "text/plain") ??
    null
  );
}

// audio/video recordings need Whisper; a native Google Doc (Meet's own
// auto-generated transcript) and plain-text files already have their words
// on the page, so those skip transcription entirely via pregivenTranscriptText.
async function buildTranscribeInputForFile(file: {
  id: string;
  name: string;
  mimeType: string;
}): Promise<TranscribeInput | null> {
  if (isGoogleDoc(file.mimeType)) {
    const text = await exportDocTranscriptText(file.id);
    if (!text.trim()) return null;
    return {
      buffer: Buffer.alloc(0),
      filename: file.name,
      mimeType: file.mimeType,
      source: "MEET",
      createdById: null,
      meetRecordingId: file.id,
      pregivenTranscriptText: text,
    };
  }

  if (file.mimeType === "text/plain") {
    const buffer = await downloadFileBuffer(file.id);
    const text = buffer.toString("utf-8");
    if (!text.trim()) return null;
    return {
      buffer: Buffer.alloc(0),
      filename: file.name,
      mimeType: file.mimeType,
      source: "MEET",
      createdById: null,
      meetRecordingId: file.id,
      pregivenTranscriptText: text,
    };
  }

  if (file.mimeType.startsWith("audio/") || file.mimeType.startsWith("video/")) {
    const buffer = await downloadFileBuffer(file.id);
    return {
      buffer,
      filename: file.name,
      mimeType: file.mimeType,
      source: "MEET",
      createdById: null,
      meetRecordingId: file.id,
    };
  }

  return null; // unsupported file type in the folder — silently skipped
}

/**
 * Polls the configured Drive folder for new Meet recordings/transcripts not
 * yet imported (dedup via VoiceTranscript.meetRecordingId), and runs each
 * one through the same transcribe→extract→draft pipeline uploads use.
 * Sequential and awaited per file — this already runs inside a background
 * cron tick, so there's no caller left waiting on it, and running Whisper/
 * Claude calls one at a time avoids bursting rate limits on a backlog.
 */
export async function runGoogleMeetSync(): Promise<GoogleMeetSyncResult> {
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
    // just the one best representative file per subfolder (see
    // pickBestMeetingFile), not every file inside it.
    const topLevel = await listFilesInFolder(folderId, env.googleMeetMaxPerPoll * 3);
    const files: DriveFile[] = [];
    for (const item of topLevel) {
      if (isFolder(item.mimeType)) {
        const best = pickBestMeetingFile(await listFilesInFolder(item.id, 20));
        if (best) files.push(best);
      } else {
        files.push(item);
      }
    }
    result.seen = files.length;

    let processedThisRun = 0;
    for (const file of files) {
      if (processedThisRun >= env.googleMeetMaxPerPoll) break;

      const already = await prisma.voiceTranscript.findUnique({ where: { meetRecordingId: file.id } });
      if (already) {
        result.skipped++;
        continue;
      }

      const input = await buildTranscribeInputForFile(file);
      if (!input) {
        result.skipped++;
        continue;
      }

      const job = await prisma.voiceProcessingJob.create({ data: { source: "MEET", status: "PENDING", createdById: null } });
      await processJobInBackground(job.id, input);
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
