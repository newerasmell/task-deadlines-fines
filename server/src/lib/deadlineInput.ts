import { DateTime } from "luxon";
import { z } from "zod";
import { env } from "./env";

// Shared across every route that accepts a deadline typed/picked by a human
// (voice draft approve/patch, chain-step approve, manual task create/edit).
//
// A bare "YYYY-MM-DD" string — what an <input type="date"> submits, used by
// the voice-review approve form — is NOT safe to hand to `new Date(...)`/
// `z.coerce.date()`: per the JS spec, a date-only ISO string parses as UTC
// MIDNIGHT, not midnight (or any other hour) in the team's own zone.
// Confirmed live: every voice-approved task landed at 03:00 — UTC midnight
// displayed in Europe/Sofia's +3 (EEST) offset — even though the draft's
// own computed deadline (see resolveDeadline in taskExtraction.ts) was
// already correct; the approve form's date-only picker silently threw that
// away and substituted this. A date-only input is treated the same way
// resolveDeadline treats one: 18:00 team-local (end of workday) on that
// day, not UTC midnight.
export const deadlineFieldSchema = z
  .string()
  .transform((val, ctx) => {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val);
    const parsed = dateOnly
      ? DateTime.fromObject(
          { year: Number(dateOnly[1]), month: Number(dateOnly[2]), day: Number(dateOnly[3]), hour: 18 },
          { zone: env.timezone }
        ).toJSDate()
      : new Date(val);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Невалидна дата за краен срок." });
      return z.NEVER;
    }
    return parsed;
  })
  // Confirmed live alongside the above: the approve form also let a
  // resulting deadline through even when it was already in the past (an
  // immediately-"Overdue" task) — nothing anywhere rejected it. Same
  // safety resolveDeadline's own fallback already applies to an
  // AI-guessed date; a human-picked one deserves the same floor.
  .refine((d) => d.getTime() >= Date.now(), { message: "Крайният срок не може да бъде в миналото." });
