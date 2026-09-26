import Anthropic from "@anthropic-ai/sdk";
import { DateTime } from "luxon";
import { z } from "zod";
import { addWorkingDays } from "./bulgarianDeadlines";
import { env } from "./env";
import { prisma } from "./prisma";

// Kept as an env override (not hardcoded) since model ids change over time
// and this shouldn't need a code change to bump.
const DEFAULT_MODEL = "claude-sonnet-5";

const suggestedAssigneeSchema = z.object({
  assignee_id: z.string().min(1),
  reason: z.string().min(1),
});

const extractedTaskSchema = z.object({
  // "extracted": the transcript actually states this as a task to do.
  // "ai_opportunity": Claude noticed something implied (a problem, gap, or
  // idea discussed but never phrased as an assignment) — see the
  // "ПРЕДЛОЖЕНИЯ ОТ AI" prompt section. Same shape, same approval flow,
  // just rendered in a clearly separate section for the admin.
  task_type: z.enum(["extracted", "ai_opportunity"]).default("extracted"),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  // What counts as this task being done — see "ОПРЕДЕЛЕНИЕ ЗА ЗАВЪРШЕНА
  // ЗАДАЧА" below. Always required: either quoted from the transcript
  // (dod_source "stated") or generated from the task + assignee's own
  // profile when nobody said one out loud ("ai_suggested").
  definition_of_done: z.string().min(1),
  dod_source: z.enum(["stated", "ai_suggested"]),
  assignee_id: z.string().min(1),
  // Only when assignee_id is "unassigned" — 1-2 reasoned guesses at who
  // this should go to, so the admin sees a starting point instead of a
  // bare empty dropdown. Never set alongside a confident assignee_id.
  suggested_assignees: z.array(suggestedAssigneeSchema).max(2).nullable().optional(),
  // Set only when the transcript explicitly names someone to review/approve
  // the finished work (e.g. "предай на Ани за преглед") — never inferred
  // from a role description the way assignee_id can be; this is a much
  // rarer, always-explicit thing to say out loud. null otherwise.
  owner_id: z.string().nullable().optional(),
  deadline: z.string().nullable().optional(),
  // 24h "HH:MM" — only when the conversation actually states a time
  // ("до петък в 15:30", "утре следобед в 14 часа"); null otherwise (the
  // server picks a default hour rather than guessing one here).
  deadline_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .nullable()
    .optional(),
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
- id="unassigned" — използвай това САМО ако наистина не е ясно на кого принадлежи задачата, дори след като си преценил по описанията по-горе; никога не познавай на случаен принцип. Виж "ПРЕДЛОЖЕН ИЗПЪЛНИТЕЛ" по-долу — дори при "unassigned" все пак предложи кандидат(и), просто не решавай вместо администратора.
${namedOnlyList.length > 0 ? `\nВАЖНО: ${namedOnlyList.join(", ")} са маркирани "само при изрично споменаване по име" (виж ⚠️ до тях по-горе) — дори ако описанието им звучи като най-добро съвпадение за дадена задача, НЕ ги избирай за assignee_id освен ако разговорът не ги е назовал директно по име. В такъв случай прецени по описанията на останалите (без ограничение), а ако наистина никое не пасва, върни "unassigned".\n` : ""}
${globalRules ? `\nОбщи правила за разпределяне (важат в допълнение към описанията по-горе, и имат предимство при конфликт с тях):\n${globalRules}\n` : ""}
За всяко конкретно, действимо нещо, което трябва да се свърши, върни един обект с точно тези полета:
- "task_type": "extracted" — за всяка задача от този основен раздел (виж отделния раздел "ПРЕДЛОЖЕНИЯ ОТ AI" по-долу за другата стойност, "ai_opportunity").
- "title": кратко заглавие (до ~120 символа)
- "description": по-подробно описание, ако има нужда от повече контекст (или null)
- "assignee_id": ако задачата назовава конкретен човек по име — използвай неговия id. Ако не назовава никого изрично, прецени по описанията на отговорностите/експертизата по-горе кой е най-подходящ и върни неговия id (спазвайки ограничението "само при изрично споменаване" по-горе, ако има такива хора). Използвай "unassigned" само ако наистина никое описание не пасва достатъчно добре.

ПРЕДЛОЖЕН ИЗПЪЛНИТЕЛ (само когато assignee_id е "unassigned"):
- "suggested_assignees": масив от 1 до 2 обекта {"assignee_id": "...", "reason": "..."} — твоите най-добри предположения, всяко с кратка причина на български (на база КАКВО в разговора и КОЯ отговорност/правило от описанията по-горе го прави подходящ). Ако е двусмислено между двама конкретни хора, предложи и двамата с отделни причини. Ако наистина никой не изглежда дори приблизително подходящ, остави null. Никога не слагай suggested_assignees, когато assignee_id вече е конкретен човек (не "unassigned").

ОПРЕДЕЛЕНИЕ ЗА ЗАВЪРШЕНА ЗАДАЧА (задължително за всяка задача):
- "definition_of_done": едно ясно изречение/кратък параграф какво точно означава задачата да е свършена — конкретен, проверим критерий, не общи думи. Първо провери дали разговорът САМ Е КАЗАЛ какво се счита за завършено (напр. "готово е като качиш файла и пуснеш линк в чата") — ако да, използвай точно него (перифразирай стегнато, ако е нужно) и сложи "dod_source": "stated". Ако НЕ е казано изрично, генерирай разумно определение сам, на база вида на задачата и описанието на отговорностите на изпълнителя по-горе (напр. за отчет — "попълнена таблица + изпратена на посочения получател"; за техническа поправка — "промяната е на живо на сайта и проверена, че работи"), и сложи "dod_source": "ai_suggested". Никога не оставяй definition_of_done празно.
- "dod_source": "stated" | "ai_suggested" — виж по-горе.

- "owner_id": попълни го САМО ако разговорът изрично казва, че готовата работа трябва да мине през преглед/одобрение от конкретен човек (напр. "предай на Ани за преглед", "Мила да провери и одобри", "изпрати резултата на Мартин за одобрение"). Това НЕ е същото като assignee_id — owner_id е преглеждащият, assignee_id е изпълнителят, и те не могат да съвпадат. Никога не гадай owner_id по описание на отговорности, само при изрично казано в разговора; в противен случай null.
- "deadline": ISO дата (YYYY-MM-DD), изчислена спрямо днешната дата (${todayIso()}). Примери: "до петък" → следващия петък; "утре" → утрешната дата; "до края на седмицата" → тази или следващата петък (в зависимост от контекста); "до края на месеца" → последният ден на текущия месец; "спешно"/"днес" → днешната дата. Ако в записа изобщо не е спомената дата, върни null (сървърът ще сложи разумен срок по подразбиране).
- "deadline_time": ако разговорът изрично казва час ("до петък в 15:30", "утре сутрин в 9", "до 14 часа днес") — върни го като "HH:MM" в 24-часов формат (напр. "15:30", "09:00", "14:00"). Ако НЕ е споменат конкретен час, върни null — сървърът ще сложи час по подразбиране, не гадай час сам.
- "priority": "low" | "normal" | "high" — по подразбиране "normal"; "high" при спешност/спомената дума като "спешно", "днес", "веднага".
- "source_quote": точният цитат (изречение/изречения) от транскрипта, от който произлиза тази задача — задължително поле, нужно е да се провери, че AI-то е разбрало правилно.

Един разговор може да съдържа много отделни задачи — раздели ги правилно по отделни обекти, не ги сливай в една.

СЛОЖНИ ЗАДАЧИ (верига от зависими стъпки): ако в разговора Е КАЗАНО ИЗРИЧНО, че една задача трябва да се случи чак след като друга приключи (напр. "първо да направим X, а после Y", "Y ще започне едва след като X бъде одобрено/готово", "Y — 3 дни след като приключи X") — тогава и само тогава маркирай тези задачи като верига:
- "chain_group": едно и също цяло число (1, 2, ...) за всички стъпки от една и съща верига, различно число за друга отделна верига в същия разговор. null за всяка обикновена самостоятелна задача — това е по подразбиране, не гадай зависимост, ако не е казана изрично.
- Подреди стъпките на веригата в масива в реда, в който трябва да се случат (първата стъпка на веригата се появява първа в масива, следващата — след нея).
- "delay_days_after_previous": само за стъпка 2+ от верига — брой дни след като предходната стъпка бъде одобрена, преди тази да стане активна (число, изведено от разговора: "3 дни след", "седмица по-късно" → 7, и т.н.; ако не е споменат конкретен брой дни, но зависимостта е ясна, сложи разумна стойност като 1). null за стъпка 1 и за всяка обикновена задача.
- "chain_title": само за ПЪРВАТА стъпка от верига — кратко име на цялата поредица (напр. "Кампания Black Friday"). null за всички останали стъпки (включително обикновените задачи).
- Верига от само 1 задача няма смисъл — ако не си сигурен, че има поне 2 ясно зависими стъпки, остави chain_group null за всички.

ПРЕДЛОЖЕНИЯ ОТ AI (task_type: "ai_opportunity"): освен изрично поисканите задачи, отбележи и проблеми/пропуски/идеи, които са ОБСЪДЕНИ в разговора, но НИКОГА не са формулирани като задача на никого (напр. повтарящо се оплакване, спомената идея без последващо действие, забелязан пропуск). За всяка такава добави обект в СЪЩИЯ масив, с task_type "ai_opportunity", и попълни всички същите полета (title, definition_of_done, assignee_id/suggested_assignees, deadline, priority, source_quote) по същите правила както по-горе. Бъди консервативен:
- Максимум 3-5 такива на разговор — само когато има конкретен цитат, на който да се опреш (source_quote е също толкова задължителен тук).
- Никога не измисляй хипотетични задачи, които не произлизат директно от нещо реално казано.
- Ако не забелязваш нищо истинско от този тип, просто не добавяй нито един — празно е напълно нормално.

Върни САМО валиден JSON масив от такива обекти (обикновени "extracted" задачи и евентуални "ai_opportunity" предложения, смесени в един масив) — без markdown code fences (без \`\`\`), без обяснителен текст преди или след него. Ако в транскрипта няма никакви конкретни задачи, върни празен масив [].`;
}

// Constructed lazily (not at module load) so a missing key surfaces as the
// Bulgarian error below instead of an SDK-thrown one the moment this file
// is imported.
let anthropicClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!env.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY не е зададен на сървъра — извличането на задачи изисква го.");
  }
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: env.anthropicApiKey, baseURL: env.anthropicApiBaseUrl });
  }
  return anthropicClient;
}

async function callClaude(
  systemPrompt: string,
  userMessage: string
): Promise<{ text: string; inputTokens: number; outputTokens: number; stopReason: string | null }> {
  const client = getAnthropicClient();

  // A long meeting (40+ minutes, easily a dozen-plus tasks) can genuinely
  // need well more JSON than fits in a few thousand output tokens — each
  // task's title/description/definition_of_done/source_quote alone can run
  // several hundred tokens apiece. A lower non-streaming cap here was
  // silently truncating the JSON array mid-object on exactly those meetings
  // (confirmed live: a task-dense recording still got cut off, and the
  // one retry, at the same cap, hit the identical wall) — surfaced as
  // "Claude did not return valid JSON" with no hint it was actually a
  // length cutoff. Streaming (required by the SDK for a max_tokens this
  // large, to avoid the request timing out before the full response
  // arrives) plus a much higher cap removes that ceiling for all but the
  // most extreme recordings.
  const stream = client.messages.stream({
    model: process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL,
    max_tokens: 64000,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });
  const message = await stream.finalMessage();

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return {
    text,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    stopReason: message.stop_reason,
  };
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

  const truncated = retry.stopReason === "max_tokens";
  throw new ExtractionParseError(
    truncated
      ? "Claude отговорът беше отрязан заради лимита на токени (твърде много извлечени задачи за един разговор) и след повторен опит."
      : "Claude не върна валиден JSON и след повторен опит.",
    retry.text
  );
}

// Used whenever the conversation names a date/deadline but never states a
// time out loud — an early-afternoon default reads as "sometime today",
// not "end of workday" like the old fixed 18:00 did, and is what the
// review screen's "time assumed" hint (see deadlineTimeAssumed) is about:
// a stand-in the admin is expected to glance at, not a real deadline.
const DEFAULT_DEADLINE_HOUR = 14;

export interface ResolvedDeadline {
  date: Date;
  // true when rawTime was missing/unparseable and DEFAULT_DEADLINE_HOUR was
  // used instead of an hour the conversation actually stated.
  timeWasAssumed: boolean;
}

/**
 * Resolves an extracted task's deadline (date + optional spoken time) into
 * a real Date. Falls back to today + VOICE_DEFAULT_DEADLINE_WORKING_DAYS
 * (skipping weekends/BG holidays) when the model didn't return a date, or
 * returned something unparseable/in the past — a bad date from the model
 * shouldn't silently become "yesterday". The hour/minute come from rawTime
 * when the conversation actually stated one, otherwise DEFAULT_DEADLINE_HOUR
 * — same fallback either way, whether or not a date was found.
 *
 * "Local" here means the TEAM's zone (env.timezone, Europe/Sofia by
 * default) — confirmed live that every voice-created task landed at a
 * wildly wrong hour because this used the plain `Date(y, m, d, 18, ...)`
 * constructor, which JS interprets in the SERVER PROCESS's own local zone,
 * not the team's. Render runs that process in UTC (see dateFormat.ts's
 * own comment on the same mismatch), so "18:00" was actually being stored
 * as 18:00 UTC — visibly wrong once anything formats it in Sofia time.
 * Luxon's zone-aware DateTime avoids that ambiguity entirely, the same way
 * businessHours.ts already does for review deadlines.
 */
export function resolveDeadline(
  rawDeadline: string | null | undefined,
  rawTime: string | null | undefined,
  now: Date = new Date()
): ResolvedDeadline {
  const timeMatch = rawTime?.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  const hour = timeMatch ? Number(timeMatch[1]) : DEFAULT_DEADLINE_HOUR;
  const minute = timeMatch ? Number(timeMatch[2]) : 0;
  const timeWasAssumed = !timeMatch;

  if (rawDeadline) {
    const match = rawDeadline.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (match) {
      const [, y, m, d] = match;
      const candidate = DateTime.fromObject(
        { year: Number(y), month: Number(m), day: Number(d), hour, minute },
        { zone: env.timezone }
      ).toJSDate();
      const startOfToday = DateTime.fromJSDate(now, { zone: env.timezone }).startOf("day").toJSDate();
      if (candidate.getTime() >= startOfToday.getTime()) {
        return { date: candidate, timeWasAssumed };
      }
    }
  }
  const fallbackDay = addWorkingDays(now, env.voiceDefaultDeadlineWorkingDays);
  const date = DateTime.fromJSDate(fallbackDay, { zone: env.timezone })
    .set({ hour, minute, second: 0, millisecond: 0 })
    .toJSDate();
  return { date, timeWasAssumed };
}

export function priorityToTaskPriority(p: ExtractedTask["priority"]): "LOW" | "MEDIUM" | "HIGH" {
  if (p === "high") return "HIGH";
  if (p === "low") return "LOW";
  return "MEDIUM";
}
