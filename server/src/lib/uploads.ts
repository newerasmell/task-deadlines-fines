import { randomUUID } from "crypto";
import fs from "fs";
import multer from "multer";
import path from "path";
import { env } from "./env";

export const uploadsRoot = path.resolve(__dirname, "..", "..", env.uploadsDir);

fs.mkdirSync(uploadsRoot, { recursive: true });

const ALLOWED_MIME_PREFIXES = ["image/"];
const ALLOWED_MIME_EXACT = ["application/pdf"];
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 5;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsRoot),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10);
    cb(null, `${randomUUID()}${ext}`);
  },
});

export const uploadAttachments = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    const ok =
      ALLOWED_MIME_EXACT.includes(file.mimetype) ||
      ALLOWED_MIME_PREFIXES.some((prefix) => file.mimetype.startsWith(prefix));
    if (ok) cb(null, true);
    else cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

export function absoluteUploadPath(storedFilename: string): string {
  return path.join(uploadsRoot, storedFilename);
}
