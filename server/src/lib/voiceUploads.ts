import multer from "multer";

// Memory storage, not disk — audio is streamed straight through to Whisper
// and never needs to touch Render's ephemeral filesystem at all (stricter
// than the brief's own "no more than a temp file" allowance).
//
// The cap here isn't arbitrary: OpenAI's Whisper API hard-rejects any file
// over 25MB, and there's no chunking/compression step in this delivery —
// that's real future work (Phase 3/4 recordings are short enough that this
// hasn't mattered yet; a 30+ minute Meet recording might need it later).
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

export const uploadAudio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("video/")) {
      return cb(new Error("Видео файлове не се поддържат — качи само аудио (mp3, m4a, wav, webm, ogg)."));
    }
    if (!file.mimetype.startsWith("audio/")) {
      return cb(new Error(`Неподдържан тип файл: ${file.mimetype}. Приемат се mp3, m4a, wav, webm, ogg.`));
    }
    cb(null, true);
  },
});

export const MAX_AUDIO_BYTES_LIMIT = MAX_AUDIO_BYTES;
