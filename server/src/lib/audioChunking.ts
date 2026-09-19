import { spawn } from "child_process";
import { mkdtemp, readdir, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(cmd)} exited ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

async function probeDurationSeconds(filePath: string): Promise<number> {
  const stdout = await run(ffprobeStatic.path, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`Не успях да определя продължителността на ${filePath}`);
  return seconds;
}

export interface AudioChunks {
  // Absolute paths, in order — each a real .mp3 file under maxBytes.
  paths: string[];
  // Removes the temp directory these live in. Always call this once done
  // reading them, success or failure.
  cleanup: () => Promise<void>;
}

/**
 * Turns a downloaded recording (already on disk — see downloadFileToTempFile,
 * never a Buffer: a Meet recording can be a long video, and loading that
 * whole thing into memory risks an OOM crash well before this even gets to
 * shrink it down) into one or more audio chunk files, each safely under
 * Whisper's hard per-file cap. Always transcodes to mono, low-bitrate MP3
 * first — dropping the video track alone is usually enough to get well
 * under the cap on its own — and only splits into multiple segments if the
 * transcoded audio is still too big. Byte-slicing the original container
 * instead (skipping ffmpeg) would produce invalid, undecodable fragments
 * for formats like mp4/webm, so every path here goes through a real
 * transcode. Returns file paths rather than loaded buffers so a long
 * recording's many chunks are never all resident in memory at once — the
 * caller reads (and can discard) one at a time.
 */
export async function prepareAudioChunks(inputPath: string, maxBytes: number): Promise<AudioChunks> {
  if (!ffmpegPath) throw new Error("ffmpeg-static не намери ffmpeg binary за тази платформа.");

  const dir = await mkdtemp(path.join(tmpdir(), "voice-chunk-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });

  try {
    const fullMp3Path = path.join(dir, "full.mp3");
    await run(ffmpegPath, ["-y", "-i", inputPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", fullMp3Path]);
    const fullMp3Size = (await stat(fullMp3Path)).size;
    if (fullMp3Size <= maxBytes) return { paths: [fullMp3Path], cleanup };

    const durationSeconds = await probeDurationSeconds(fullMp3Path);
    const chunkCount = Math.ceil(fullMp3Size / maxBytes);
    // A floor keeps a single-frame remainder from ffmpeg's segment muxer's
    // own overhead from ever pushing a chunk back over maxBytes.
    const chunkSeconds = Math.max(30, Math.floor(durationSeconds / chunkCount));

    const segmentPattern = path.join(dir, "chunk_%04d.mp3");
    await run(ffmpegPath, ["-y", "-i", fullMp3Path, "-f", "segment", "-segment_time", String(chunkSeconds), "-c", "copy", segmentPattern]);

    const chunkFiles = (await readdir(dir)).filter((f) => f.startsWith("chunk_")).sort();
    if (chunkFiles.length === 0) throw new Error("ffmpeg не произведе части от записа.");
    return { paths: chunkFiles.map((f) => path.join(dir, f)), cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
