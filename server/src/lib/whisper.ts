import { env } from "./env";

export interface WhisperResult {
  text: string;
  language?: string;
  durationSeconds?: number;
}

// Whisper pricing at $0.006/minute — used only to populate the cost-tracking
// columns on VoiceTranscript (see the brief's "log token/API costs"
// requirement), never for actual billing.
const WHISPER_USD_PER_MINUTE = 0.006;

export function estimateWhisperCostUsd(durationSeconds: number | null | undefined): number | null {
  if (!durationSeconds) return null;
  return Math.round((durationSeconds / 60) * WHISPER_USD_PER_MINUTE * 10000) / 10000;
}

/**
 * Streams an audio buffer straight to OpenAI's Whisper API — never written
 * to local disk beyond whatever multer/Node briefly buffers in memory for
 * the request, per the brief's "assume the filesystem is ephemeral" rule.
 * `language: "bg"` is a hint, not a hard lock: these recordings often mix
 * Bulgarian with English brand/tool names, and forcing the language would
 * mis-transcribe those segments instead of just auto-detecting them.
 */
export async function transcribeAudio(buffer: Buffer, filename: string, mimeType: string): Promise<WhisperResult> {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY не е зададен на сървъра — гласовите функции изискват го.");
  }

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), filename);
  form.append("model", "whisper-1");
  form.append("language", "bg");
  form.append("response_format", "verbose_json");

  const res = await fetch(`${env.openaiApiBaseUrl}/v1/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.openaiApiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Whisper API HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as { text: string; language?: string; duration?: number };
  return {
    text: data.text,
    language: data.language,
    durationSeconds: typeof data.duration === "number" ? Math.round(data.duration) : undefined,
  };
}
