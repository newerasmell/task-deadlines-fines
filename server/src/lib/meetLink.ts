import { z } from "zod";

// Shared by every place a task's optional video-call link (Google Meet or
// any other http(s) URL) gets accepted — a single task's create/update and
// each step of a "сложна задача". Empty string means "clear the link"
// (normalized to null); anything else must be a real http(s) URL, since
// this value later gets handed straight to window.open() on the frontend
// and a javascript:/data: URL there would be a real XSS vector.
export const meetLinkField = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .nullable()
  .optional()
  .refine((v) => !v || /^https?:\/\//i.test(v), {
    message: "Meet линкът трябва да започва с http:// или https://",
  });
