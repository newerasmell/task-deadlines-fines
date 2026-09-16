import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { MulterError } from "multer";
import { uploadAudio } from "../lib/voiceUploads";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { createProjectAndNotify } from "../services/projectCreation";
import { createTaskAndNotify } from "../services/taskCreation";
import {
  errorMessageFor,
  extractAndCreateDrafts,
  processJobInBackground,
  transcribeAndStore,
  type VoiceSource,
} from "../services/voiceProcessing";
import { env } from "../lib/env";
import { getLastGoogleMeetSyncResult, runGoogleMeetSync } from "../jobs/googleMeetSync";

export const voiceRouter = Router();

// The whole voice-to-tasks feature is admin-only — nothing here is ever
// visible to a regular employee; they only ever see the real Task an
// approved draft turns into, through the normal Tasks views.
voiceRouter.use(requireAuth);
voiceRouter.use(requireAdmin);

const draftInclude = {
  resolvedAssignee: { select: { id: true, name: true, email: true } },
  transcript: { select: { id: true, source: true, originalFilename: true, createdAt: true } },
} as const;

const SOURCES = ["UPLOAD", "MEET", "DICTATION"] as const;

// Wrapped rather than passed directly as route middleware: multer's own
// fileFilter/size-limit errors otherwise fall through to the app-wide
// error handler, which only ever answers "Internal server error" — losing
// the specific, human-readable Bulgarian message (wrong file type, too
// large) the brief explicitly asks for on audio operations.
function handleAudioUpload(req: Request, res: Response, next: NextFunction) {
  uploadAudio.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "Файлът е твърде голям (максимум 24MB)." });
    }
    res.status(400).json({ error: err instanceof Error ? err.message : "Грешка при качване на файла." });
  });
}

voiceRouter.post("/transcribe", handleAudioUpload, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Няма качен файл" });

  const sourceRaw = (typeof req.body.source === "string" ? req.body.source.toUpperCase() : "UPLOAD") as VoiceSource;
  const source = SOURCES.includes(sourceRaw) ? sourceRaw : "UPLOAD";

  const input = {
    buffer: req.file.buffer,
    filename: req.file.originalname || `recording-${Date.now()}.webm`,
    mimeType: req.file.mimetype,
    source,
    createdById: req.user!.sub,
  };

  // Short recordings are processed inline — a few seconds of Whisper +
  // Claude latency is fine to hold the request open for. Longer ones go
  // through the VoiceProcessingJob background path instead (see
  // GET /voice/jobs/:id) so the request doesn't sit open for minutes.
  if (req.file.size <= env.voiceSyncMaxBytes) {
    try {
      const transcriptId = await transcribeAndStore(input);
      const draftsCreated = await extractAndCreateDrafts(transcriptId);
      return res.json({ ok: true, sync: true, transcriptId, draftsCreated });
    } catch (err) {
      return res.status(502).json({ ok: false, error: errorMessageFor(err) });
    }
  }

  const job = await prisma.voiceProcessingJob.create({
    data: { source, status: "PENDING", createdById: req.user!.sub },
  });
  void processJobInBackground(job.id, input).catch((err) => {
    console.error(`[voice] background job ${job.id} crashed outside its own try/catch:`, err);
  });
  res.json({ ok: true, sync: false, jobId: job.id });
});

voiceRouter.get("/transcripts/:id", async (req, res) => {
  const transcript = await prisma.voiceTranscript.findUnique({ where: { id: req.params.id } });
  if (!transcript) return res.status(404).json({ error: "Not found" });
  res.json(transcript);
});

voiceRouter.get("/jobs/:id", async (req, res) => {
  const job = await prisma.voiceProcessingJob.findUnique({ where: { id: req.params.id } });
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

voiceRouter.get("/drafts", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : "DRAFT";
  const transcriptId = typeof req.query.transcriptId === "string" ? req.query.transcriptId : undefined;
  const drafts = await prisma.voiceTaskDraft.findMany({
    where: { status, ...(transcriptId ? { transcriptId } : {}) },
    include: draftInclude,
    orderBy: { createdAt: "desc" },
  });
  res.json(drafts);
});

voiceRouter.get("/drafts/:id", async (req, res) => {
  const draft = await prisma.voiceTaskDraft.findUnique({
    where: { id: req.params.id },
    include: { ...draftInclude, transcript: true },
  });
  if (!draft) return res.status(404).json({ error: "Not found" });
  res.json(draft);
});

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  deadline: z.coerce.date().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
});

voiceRouter.patch("/drafts/:id", async (req, res) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const existing = await prisma.voiceTaskDraft.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Not found" });
  if (existing.status !== "DRAFT") return res.status(400).json({ error: "Само чернова може да се редактира" });

  const { assigneeId, ...rest } = parsed.data;
  const draft = await prisma.voiceTaskDraft.update({
    where: { id: req.params.id },
    data: { ...rest, ...(assigneeId !== undefined ? { resolvedAssigneeId: assigneeId } : {}) },
    include: draftInclude,
  });
  res.json(draft);
});

const approveSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  assigneeId: z.string().min(1),
  ownerId: z.string().nullable().optional(),
  deadline: z.coerce.date().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
});

voiceRouter.post("/drafts/:id/approve", async (req, res) => {
  const parsed = approveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const draft = await prisma.voiceTaskDraft.findUnique({ where: { id: req.params.id } });
  if (!draft) return res.status(404).json({ error: "Not found" });
  if (draft.status !== "DRAFT") return res.status(400).json({ error: "Тази чернова вече е обработена" });

  if (parsed.data.ownerId && parsed.data.ownerId === parsed.data.assigneeId) {
    return res.status(400).json({ error: "Owner-ът не може да е самият изпълнител" });
  }

  let task;
  try {
    task = await createTaskAndNotify({
      title: parsed.data.title ?? draft.title,
      description: parsed.data.description ?? draft.description,
      assigneeId: parsed.data.assigneeId,
      ownerId: parsed.data.ownerId ?? null,
      deadline: parsed.data.deadline ?? draft.deadline,
      priority: parsed.data.priority ?? (draft.priority as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"),
      createdById: req.user!.sub,
    });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : "Грешка при създаване на задачата" });
  }

  const updatedDraft = await prisma.voiceTaskDraft.update({
    where: { id: draft.id },
    data: {
      title: parsed.data.title ?? draft.title,
      description: parsed.data.description ?? draft.description,
      resolvedAssigneeId: parsed.data.assigneeId,
      deadline: parsed.data.deadline ?? draft.deadline,
      priority: parsed.data.priority ?? draft.priority,
      status: "APPROVED",
      approvedAt: new Date(),
      approvedTaskId: task.id,
    },
    include: draftInclude,
  });

  res.json({ draft: updatedDraft, task });
});

voiceRouter.post("/drafts/:id/reject", async (req, res) => {
  const draft = await prisma.voiceTaskDraft.findUnique({ where: { id: req.params.id } });
  if (!draft) return res.status(404).json({ error: "Not found" });
  if (draft.status !== "DRAFT") return res.status(400).json({ error: "Тази чернова вече е обработена" });

  const updated = await prisma.voiceTaskDraft.update({
    where: { id: draft.id },
    data: { status: "REJECTED" },
    include: draftInclude,
  });
  res.json(updated);
});

// Approves every still-draft item under one transcript using its current
// stored fields, as-is — items with no resolved assignee are skipped (a
// real Task can't be created without one) rather than guessing; the admin
// approves those individually after picking someone on the review screen.
voiceRouter.post("/transcripts/:id/approve-all", async (req, res) => {
  const drafts = await prisma.voiceTaskDraft.findMany({
    where: { transcriptId: req.params.id, status: "DRAFT" },
  });

  let approved = 0;
  const skipped: { draftId: string; title: string; reason: string }[] = [];

  for (const draft of drafts) {
    if (!draft.resolvedAssigneeId) {
      skipped.push({ draftId: draft.id, title: draft.title, reason: "Няма определен изпълнител" });
      continue;
    }
    try {
      const task = await createTaskAndNotify({
        title: draft.title,
        description: draft.description,
        assigneeId: draft.resolvedAssigneeId,
        deadline: draft.deadline,
        priority: draft.priority as "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
        createdById: req.user!.sub,
      });
      await prisma.voiceTaskDraft.update({
        where: { id: draft.id },
        data: { status: "APPROVED", approvedAt: new Date(), approvedTaskId: task.id },
      });
      approved++;
    } catch (err) {
      skipped.push({ draftId: draft.id, title: draft.title, reason: err instanceof Error ? err.message : "Грешка" });
    }
  }

  res.json({ approved, skipped });
});

const chainStepApproveSchema = z.object({
  draftId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  assigneeId: z.string().min(1),
  ownerId: z.string().nullable().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  // Step 1 only.
  deadline: z.coerce.date().optional(),
  // Steps 2+ only.
  delayDays: z.number().int().min(1).max(90).optional(),
});

const chainApproveSchema = z.object({
  projectTitle: z.string().min(1),
  steps: z.array(chainStepApproveSchema).min(2).max(4),
});

// Approves an entire detected chain (see the "СЛОЖНИ ЗАДАЧИ" extraction
// prompt section) as one real multi-step Project in a single call, instead
// of one draft at a time — a chain step in isolation can't become a real
// Task on its own (steps 2+ have no deadline yet, only a delay), so this
// is the only way voice-detected chain drafts turn into anything real.
voiceRouter.post("/chains/:chainGroupId/approve", async (req, res) => {
  const parsed = chainApproveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const drafts = await prisma.voiceTaskDraft.findMany({
    where: { chainGroupId: req.params.chainGroupId },
    orderBy: { chainOrder: "asc" },
  });
  if (drafts.length < 2) return res.status(404).json({ error: "Not found" });
  if (drafts.some((d) => d.status !== "DRAFT")) {
    return res.status(400).json({ error: "Тази верига вече е обработена (частично или изцяло)" });
  }

  const draftById = new Map(drafts.map((d) => [d.id, d]));
  if (parsed.data.steps.length !== drafts.length || parsed.data.steps.some((s) => !draftById.has(s.draftId))) {
    return res.status(400).json({ error: "Стъпките не съответстват на веригата" });
  }

  // Trust the drafts' own chainOrder for sequencing, not whatever order the
  // client happened to submit them in — createProjectAndNotify treats
  // array position as chain order (step 0 = immediate deadline, the rest as
  // delays), so a client sending steps out of order would otherwise silently
  // scramble the chain.
  const steps = [...parsed.data.steps].sort((a, b) => (draftById.get(a.draftId)!.chainOrder ?? 0) - (draftById.get(b.draftId)!.chainOrder ?? 0));

  let result;
  try {
    result = await createProjectAndNotify({
      title: parsed.data.projectTitle,
      steps: steps.map((s) => ({
        assigneeId: s.assigneeId,
        title: s.title,
        description: s.description ?? undefined,
        ownerId: s.ownerId ?? undefined,
        priority: s.priority,
        deadline: s.deadline,
        delayDays: s.delayDays,
      })),
      createdById: req.user!.sub,
    });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : "Грешка при създаване на проекта" });
  }

  const now = new Date();
  const updatedDrafts = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const task = result.steps[i];
    const draft = draftById.get(step.draftId)!;
    updatedDrafts.push(
      await prisma.voiceTaskDraft.update({
        where: { id: step.draftId },
        data: {
          title: step.title,
          description: step.description ?? null,
          resolvedAssigneeId: step.assigneeId,
          priority: step.priority,
          deadline: step.deadline ?? draft.deadline,
          status: "APPROVED",
          approvedAt: now,
          approvedTaskId: task.id,
        },
        include: draftInclude,
      })
    );
  }

  res.json({ project: result.project, tasks: result.steps, drafts: updatedDrafts });
});

// Read-only status for the frontend's Google Meet settings panel: whether
// the integration is configured at all, and what the last poll (scheduled
// or manual) found.
voiceRouter.get("/meet/status", (_req, res) => {
  const configured = Boolean(env.googleClientId && env.googleClientSecret && env.googleRefreshToken);
  const { result, ranAt, inProgress } = getLastGoogleMeetSyncResult();
  res.json({
    configured,
    folderName: env.googleMeetFolderName,
    inProgress,
    lastRunAt: ranAt,
    lastResult: result,
  });
});

// Triggers an out-of-cycle sync (e.g. "I just finished a meeting, pull it
// now" instead of waiting for the next cron tick). Runs the same
// runGoogleMeetSync() the scheduler calls, awaited so the response reflects
// what actually happened rather than firing-and-forgetting a poll the admin
// can't see the result of.
voiceRouter.post("/meet/poll-now", async (_req, res) => {
  try {
    const result = await runGoogleMeetSync();
    res.json({ ok: true, result });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : "Грешка при синхронизация" });
  }
});

// Re-runs Claude extraction on an already-stored transcript — useful when
// the first extraction failed (ExtractionParseError) or the admin just
// wants a fresh pass. Any still-pending drafts from the previous run are
// cleared first so this doesn't pile up duplicates; already-approved or
// -rejected drafts are left alone as history.
voiceRouter.post("/transcripts/:id/reextract", async (req, res) => {
  const transcript = await prisma.voiceTranscript.findUnique({ where: { id: req.params.id } });
  if (!transcript) return res.status(404).json({ error: "Not found" });

  await prisma.voiceTaskDraft.deleteMany({ where: { transcriptId: transcript.id, status: "DRAFT" } });

  try {
    const draftsCreated = await extractAndCreateDrafts(transcript.id);
    res.json({ ok: true, draftsCreated });
  } catch (err) {
    res.status(502).json({ ok: false, error: errorMessageFor(err) });
  }
});
