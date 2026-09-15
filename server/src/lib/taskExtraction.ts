import { z } from "zod";
import { addWorkingDays } from "./bulgarianDeadlines";
import { env } from "./env";
import { loadTeamRoles } from "./teamRoles";

// Kept as an env override (not hardcoded) since model ids change over time
// and this shouldn't need a code change to bump.
const DEFAULT_MODEL = "claude-sonnet-5";

const extractedTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  assignee_key: z.string().min(1),
  deadline: z.string().nullable().optional(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  source_quote: z.string().min(1),
});
const extractedTasksSchema = z.array(extractedTaskSchema);

export type ExtractedTask = z.infer<typeof extractedTaskSchema>;

// Thrown only after the one retry also failed — carries the raw model
// output so the caller can show it to the admin (per the brief: "fail
// gracefully with the raw text shown to the admin") instead of a bare
// "something went wrong".
export class ExtractionParseError extends Error {
  rawText: string;
  constructor(message: string, rawText: string) {
    super(message);
    this.rawText = rawText;
  }
}

export interface ExtractionResult {
  tasks: ExtractedTask[];
  inputTokens: number;
  outputTokens: number;
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function buildSystemPrompt(): string {
  const config = loadTeamRoles();
  const roster = config.team
    .map((t) => `- key="${t.key}", name="${t.name}", отговорности: ${t.responsibilities}`)
    .join("\n");

  return `Ти извличаш конкретни задачи от транскрипт на говорен български (понякога смесен с английски) — записан разговор, среща или диктовка. Днешната дата е ${todayIso()}.

Екип (assignee_key → отговорности):
${roster}
- key="unassigned" — използвай този key САМО ако наистина не е ясно на кого принадлежи задачата; никога не познавай на случаен принцип.

За всяко конкретно, действимо нещо, което трябва да се свърши, върни един обект с точно тези полета:
- "title": кратко заглавие (до ~120 символа)
- "description": по-подробно описание, ако има нужда от повече контекст (или null)
- "assignee_key": най-подходящият key от екипа по-горе според отговорностите, или "unassigned"
- "deadline": ISO дата (YYYY-MM-DD), изчислена спрямо днешната дата (${todayIso()}). Примери: "до петък" → следващия петък; "утре" → утрешната дата; "до края на седмицата" → тази или следващата петък (в зависимост от контекста); "до края на месеца" → последният ден на текущия месец; "спешно"/"днес" → днешната дата. Ако в записа изобщо не е спомената дата, върни null (сървърът ще сложи разумен срок по подразбиране).
- "priority": "low" | "normal" | "high" — по подразбиране "normal"; "high" при спешност/спомената дума като "спешно", "днес", "веднага".
- "source_quote": точният цитат (изречение/изречения) от транскрипта, от който произлиза тази задача — задължително поле, нужно е да се провери, че AI-то е разбрало правилно.

Един разговор може да съдържа много отделни задачи — раздели ги правилно по отделни обекти, не ги сливай в една.

Върни САМО валиден JSON масив от такива обекти — без markdown code fences (без \`\`\`), без обяснителен текст преди или след него. Ако в транскрипта няма никакви конкретни задачи, върни празен масив [].`;
}

async function callClaude(systemPrompt: string, userMessage: string): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  if (!env.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY не е зададен на сървъра — извличането на задачи изисква го.");
  }

  const res = await fetch(`${env.anthropicApiBaseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Claude API HTTP ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
    usage?: { input_tokens: number; output_tokens: number };
  };
  const text = data.content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("");
  return { text, inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 };
}

// Claude is instructed not to wrap its answer in fences, but models don't
// always follow that reliably — strip ```json/``` fences defensively before
// parsing rather than failing (and burning the one retry) on formatting
// alone when the JSON itself is actually fine.
function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function tryParse(text: string): ExtractedTask[] | null {
  try {
    const parsed = JSON.parse(stripFences(text));
    const result = extractedTasksSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Extracts every actionable task from a Bulgarian transcript via Claude.
 * Retries once with an error-correction message if the first response isn't
 * valid JSON matching the schema; throws ExtractionParseError (carrying the
 * raw text) if the retry also fails, rather than guessing.
 */
export async function extractTasks(transcriptText: string): Promise<ExtractionResult> {
  const systemPrompt = buildSystemPrompt();
  const first = await callClaude(systemPrompt, transcriptText);
  const firstParsed = tryParse(first.text);
  if (firstParsed) {
    return { tasks: firstParsed, inputTokens: first.inputTokens, outputTokens: first.outputTokens };
  }

  const retry = await callClaude(
    systemPrompt,
    `${transcriptText}\n\n---\nТвоят предишен отговор не беше валиден JSON масив по описаната схема. Върни САМО JSON масива — без markdown fences, без никакъв друг текст преди или след него.`
  );
  const retryParsed = tryParse(retry.text);
  if (retryParsed) {
    return {
      tasks: retryParsed,
      inputTokens: first.inputTokens + retry.inputTokens,
      outputTokens: first.outputTokens + retry.outputTokens,
    };
  }

  throw new ExtractionParseError("Claude не върна валиден JSON и след повторен опит.", retry.text);
}

/**
 * Resolves an extracted task's deadline string into a real Date, 18:00
 * local (end-of-workday) on that day. Falls back to today +
 * default_deadline_working_days (skipping weekends/BG holidays) when the
 * model didn't return a date, or returned something unparseable/in the
 * past — a bad date from the model shouldn't silently become "yesterday".
 */
export function resolveDeadline(rawDeadline: string | null | undefined, now: Date = new Date()): Date {
  const config = loadTeamRoles();
  if (rawDeadline) {
    const match = rawDeadline.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      const [, y, m, d] = match;
      const candidate = new Date(Number(y), Number(m) - 1, Number(d), 18, 0, 0, 0);
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (candidate.getTime() >= startOfToday.getTime()) {
        return candidate;
      }
    }
  }
  const fallbackDay = addWorkingDays(now, config.default_deadline_working_days);
  return new Date(fallbackDay.getFullYear(), fallbackDay.getMonth(), fallbackDay.getDate(), 18, 0, 0, 0);
}

export function priorityToTaskPriority(p: ExtractedTask["priority"]): "LOW" | "MEDIUM" | "HIGH" {
  if (p === "high") return "HIGH";
  if (p === "low") return "LOW";
  return "MEDIUM";
}
