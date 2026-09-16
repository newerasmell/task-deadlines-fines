import { z } from "zod";
import { addWorkingDays } from "./bulgarianDeadlines";
import { env } from "./env";
import { prisma } from "./prisma";

// Kept as an env override (not hardcoded) since model ids change over time
// and this shouldn't need a code change to bump.
const DEFAULT_MODEL = "claude-sonnet-5";

const extractedTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  assignee_id: z.string().min(1),
  // Set only when the transcript explicitly names someone to review/approve
  // the finished work (e.g. "предай на Ани за преглед") — never inferred
  // from a role description the way assignee_id can be; this is a much
  // rarer, always-explicit thing to say out loud. null otherwise.
  owner_id: z.string().nullable().optional(),
  deadline: z.string().nullable().optional(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  source_quote: z.string().min(1),
  // Set together, only when the conversation explicitly says one task must
  // wait for another — see the "СЛОЖНИ ЗАДАЧИ" section of the system prompt.
  chain_group: z.number().int().nullable().optional(),
  delay_days_after_previous: z.number().int().min(1).max(90).nullable().optional(),
  chain_title: z.string().nullable().optional(),
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

// The roster Claude picks an assignee from is the live Employees list, not
// a separate hand-maintained file — every active account's own real id, so
// resolution back to a real User is exact (no email/key matching step that
// could silently miss). voiceAssignmentNotes is what actually lets it guess
// well for a task that doesn't name anyone: without it, the roster is just
// names with no signal to match against.
async function buildSystemPrompt(): Promise<string> {
  const [users, config] = await Promise.all([
    prisma.user.findMany({
      where: { active: true },
      select: { id: true, name: true, voiceAssignmentNotes: true, voiceAssignOnlyWhenNamed: true },
      orderBy: { name: "asc" },
    }),
    prisma.voiceAssignmentConfig.findUnique({ where: { id: "singleton" } }),
  ]);
  const roster = users
    .map((u) => {
      const desc = u.voiceAssignmentNotes?.trim() || "(няма описание — виж в Служители)";
      const restriction = u.voiceAssignOnlyWhenNamed
        ? " ⚠️ САМО ПРИ ИЗРИЧНО СПОМЕНАВАНЕ ПО ИМЕ — никога не му/ѝ възлагай задача по преценка от описанието, дори то да пасва добре."
        : "";
      return `- id="${u.id}", name="${u.name}", описание: ${desc}${restriction}`;
    })
    .join("\n");
  const namedOnlyList = users.filter((u) => u.voiceAssignOnlyWhenNamed).map((u) => u.name);
  const globalRules = config?.rulesText?.trim();

  return `Ти извличаш конкретни задачи от транскрипт на говорен български (понякога смесен с английски) — записан разговор, среща или диктовка. Днешната дата е ${todayIso()}.

Екип (assignee_id → описание на отговорностите/експертизата):
${roster}
- id="unassigned" — използвай това САМО ако наистина не е ясно на кого принадлежи задачата, дори след като си преценил по описанията по-горе; никога не познавай на случаен принцип.
${namedOnlyList.length > 0 ? `\nВАЖНО: ${namedOnlyList.join(", ")} са маркирани "само при изрично споменаване по име" (виж ⚠️ до тях по-горе) — дори ако описанието им звучи като най-добро съвпадение за дадена задача, НЕ ги избирай за assignee_id освен ако разговорът не ги е назовал директно по име. В такъв случай прецени по описанията на останалите (без ограничение), а ако наистина никое не пасва, върни "unassigned".\n` : ""}
${globalRules ? `\nОбщи правила за разпределяне (важат в допълнение към описанията по-горе, и имат предимство при конфликт с тях):\n${globalRules}\n` : ""}
За всяко конкретно, действимо нещо, което трябва да се свърши, върни един обект с точно тези полета:
- "title": кратко заглавие (до ~120 символа)
- "description": по-подробно описание, ако има нужда от повече контекст (или null)
- "assignee_id": ако задачата назовава конкретен човек по име — използвай неговия id. Ако не назовава никого изрично, прецени по описанията на отговорностите/експертизата по-горе кой е най-подходящ и върни неговия id (спазвайки ограничението "само при изрично споменаване" по-горе, ако има такива хора). Използвай "unassigned" само ако наистина никое описание не пасва достатъчно добре.
- "owner_id": попълни го САМО ако разговорът изрично казва, че готовата работа трябва да мине през преглед/одобрение от конкретен човек (напр. "предай на Ани за преглед", "Мила да провери и одобри", "изпрати резултата на Мартин за одобрение"). Това НЕ е същото като assignee_id — owner_id е преглеждащият, assignee_id е изпълнителят, и те не могат да съвпадат. Никога не гадай owner_id по описание на отговорности, само при изрично казано в разговора; в противен случай null.
- "deadline": ISO дата (YYYY-MM-DD), изчислена спрямо днешната дата (${todayIso()}). Примери: "до петък" → следващия петък; "утре" → утрешната дата; "до края на седмицата" → тази или следващата петък (в зависимост от контекста); "до края на месеца" → последният ден на текущия месец; "спешно"/"днес" → днешната дата. Ако в записа изобщо не е спомената дата, върни null (сървърът ще сложи разумен срок по подразбиране).
- "priority": "low" | "normal" | "high" — по подразбиране "normal"; "high" при спешност/спомената дума като "спешно", "днес", "веднага".
- "source_quote": точният цитат (изречение/изречения) от транскрипта, от който произлиза тази задача — задължително поле, нужно е да се провери, че AI-то е разбрало правилно.

Един разговор може да съдържа много отделни задачи — раздели ги правилно по отделни обекти, не ги сливай в една.

СЛОЖНИ ЗАДАЧИ (верига от зависими стъпки): ако в разговора Е КАЗАНО ИЗРИЧНО, че една задача трябва да се случи чак след като друга приключи (напр. "първо да направим X, а после Y", "Y ще започне едва след като X бъде одобрено/готово", "Y — 3 дни след като приключи X") — тогава и само тогава маркирай тези задачи като верига:
- "chain_group": едно и също цяло число (1, 2, ...) за всички стъпки от една и съща верига, различно число за друга отделна верига в същия разговор. null за всяка обикновена самостоятелна задача — това е по подразбиране, не гадай зависимост, ако не е казана изрично.
- Подреди стъпките на веригата в масива в реда, в който трябва да се случат (първата стъпка на веригата се появява първа в масива, следващата — след нея).
- "delay_days_after_previous": само за стъпка 2+ от верига — брой дни след като предходната стъпка бъде одобрена, преди тази да стане активна (число, изведено от разговора: "3 дни след", "седмица по-късно" → 7, и т.н.; ако не е споменат конкретен брой дни, но зависимостта е ясна, сложи разумна стойност като 1). null за стъпка 1 и за всяка обикновена задача.
- "chain_title": само за ПЪРВАТА стъпка от верига — кратко име на цялата поредица (напр. "Кампания Black Friday"). null за всички останали стъпки (включително обикновените задачи).
- Верига от само 1 задача няма смисъл — ако не си сигурен, че има поне 2 ясно зависими стъпки, остави chain_group null за всички.

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
  const systemPrompt = await buildSystemPrompt();
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
 * VOICE_DEFAULT_DEADLINE_WORKING_DAYS (skipping weekends/BG holidays) when
 * the model didn't return a date, or returned something unparseable/in the
 * past — a bad date from the model shouldn't silently become "yesterday".
 */
export function resolveDeadline(rawDeadline: string | null | undefined, now: Date = new Date()): Date {
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
  const fallbackDay = addWorkingDays(now, env.voiceDefaultDeadlineWorkingDays);
  return new Date(fallbackDay.getFullYear(), fallbackDay.getMonth(), fallbackDay.getDate(), 18, 0, 0, 0);
}

export function priorityToTaskPriority(p: ExtractedTask["priority"]): "LOW" | "MEDIUM" | "HIGH" {
  if (p === "high") return "HIGH";
  if (p === "low") return "LOW";
  return "MEDIUM";
}
