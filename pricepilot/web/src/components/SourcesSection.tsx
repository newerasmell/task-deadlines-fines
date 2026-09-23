import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { api } from "../api/client";
import type { AmbiguousMatch, ScrapeAttempt, Source, SourceType } from "../api/types";
import { AccordionItem } from "./Accordion";
import { useT } from "../i18n/I18nContext";
import type { useI18n } from "../i18n/I18nContext";

type T = ReturnType<typeof useI18n>["t"];

const MAX_SOURCES_PER_STORE = 4; // was 3 per the original brief; raised at the user's request

type SourceTab = "edit" | "import" | "results" | "queue";

function defaultTabFor(type: SourceType): SourceTab {
  if (type === "manual_import") return "import";
  if (type === "scrape") return "results";
  if (type === "jeftinije_hr" || type === "notino_hr") return "queue";
  return "edit";
}

function tabsFor(type: SourceType, t: T): { key: SourceTab; label: string }[] {
  const tabs: { key: SourceTab; label: string }[] = [{ key: "edit", label: t("Редактиране") }];
  if (type === "manual_import") tabs.push({ key: "import", label: t("Импортиране") });
  if (type === "scrape" || type === "manual_import") tabs.push({ key: "results", label: t("Резултати") });
  if (type === "jeftinije_hr" || type === "notino_hr" || type === "manual_import")
    tabs.push({ key: "queue", label: t("Опашка за преглед") });
  return tabs;
}

export function SourcesSection({ storeId }: { storeId: string }) {
  const t = useT();
  const [sources, setSources] = useState<Source[]>([]);
  const [addingSource, setAddingSource] = useState(false);
  // Accordion at the source level: at most one source's panel is open,
  // and within it at most one tab renders — replaces the old layout where
  // every manual_import source's whole import panel (template download +
  // two file pickers + instructions) was permanently on screen for every
  // source at once.
  const [openSourceId, setOpenSourceId] = useState<string | null>(null);
  const [openTab, setOpenTab] = useState<SourceTab>("edit");
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [refreshResult, setRefreshResult] = useState<Record<string, string>>({});

  async function refresh(): Promise<Source[]> {
    const list = await api<Source[]>(`/sources?storeId=${storeId}`);
    setSources(list);
    return list;
  }

  useEffect(() => {
    refresh();
    setOpenSourceId(null);
    setAddingSource(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  function openSource(s: Source) {
    setAddingSource(false);
    if (openSourceId === s.id) {
      setOpenSourceId(null);
      return;
    }
    setOpenSourceId(s.id);
    setOpenTab(defaultTabFor(s.type));
  }

  // A scrape refresh walks the catalog with a polite ~2-3s delay per
  // product — several minutes for ~140 targets — so the server runs it in
  // the background and responds immediately rather than holding the
  // request open (which Render's proxy would eventually kill anyway). Poll
  // GET /sources until this source's lastRefreshedAt moves past the moment
  // we kicked it off, then read the result off lastMatchedCount/lastError.
  async function refreshSource(id: string) {
    setRefreshing(id);
    setRefreshResult((cur) => ({ ...cur, [id]: t("Стартирано — извличането от източници може да отнеме няколко минути…") }));
    const requestedAt = Date.now();
    try {
      const res = await api<{ ok: boolean; started?: boolean; alreadyRunning?: boolean; error?: string }>(
        `/sources/${id}/refresh`,
        { method: "POST" }
      );
      if (!res.ok) {
        setRefreshResult((cur) => ({ ...cur, [id]: `✕ ${res.error ?? t("Грешка")}` }));
        return;
      }
      if (res.alreadyRunning) {
        setRefreshResult((cur) => ({ ...cur, [id]: t("Вече се обновява — проверете отново скоро.") }));
        return;
      }
      await pollUntilRefreshed(id, requestedAt);
    } catch (err) {
      setRefreshResult((cur) => ({ ...cur, [id]: err instanceof Error ? `✕ ${err.message}` : `✕ ${t("Грешка")}` }));
    } finally {
      setRefreshing(null);
    }
  }

  async function pollUntilRefreshed(id: string, requestedAt: number) {
    const POLL_MS = 4000;
    const MAX_MS = 15 * 60 * 1000; // generous — the largest scrape runs can legitimately take this long
    const deadline = Date.now() + MAX_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      const list = await refresh();
      const source = list.find((s) => s.id === id);
      if (source?.lastRefreshedAt && new Date(source.lastRefreshedAt).getTime() >= requestedAt) {
        setRefreshResult((cur) => ({
          ...cur,
          [id]: source.lastError
            ? `✕ ${source.lastError}`
            : t("✓ {count} извлечени цени", { count: source.lastMatchedCount ?? 0 }),
        }));
        return;
      }
    }
    setRefreshResult((cur) => ({ ...cur, [id]: t("Все още работи — проверете по-късно.") }));
  }

  async function remove(id: string) {
    if (!window.confirm(t("Изтриване на този източник? Събраните цени на конкуренти ще бъдат изтрити заедно с него."))) return;
    await api(`/sources/${id}`, { method: "DELETE" });
    if (openSourceId === id) setOpenSourceId(null);
    refresh();
  }

  return (
    <div>
      <div className="entity-list" style={{ marginBottom: addingSource ? 12 : 0 }}>
        {sources.map((s) => {
          const open = openSourceId === s.id;
          const tabs = tabsFor(s.type, t);
          return (
            <AccordionItem
              key={s.id}
              open={open}
              onToggle={() => openSource(s)}
              headerLeft={
                <span>
                  {s.label} <span className="accordion-meta">({s.type})</span>
                  {s.degraded && <span className="tag">{t("влошено")}</span>}
                  {!s.active && <span className="tag">{t("неактивно")}</span>}
                  {!s.autoRefresh && <span className="tag">{t("само ръчно")}</span>}
                </span>
              }
              headerRight={
                <div className="entity-row-actions" onClick={(e) => e.stopPropagation()}>
                  {refreshResult[s.id] && <span className="small">{refreshResult[s.id]}</span>}
                  {s.type !== "manual_import" && (
                    <button className="small-btn secondary" onClick={() => refreshSource(s.id)} disabled={refreshing === s.id}>
                      {refreshing === s.id ? t("Обновяване…") : t("Обнови сега")}
                    </button>
                  )}
                  <button className="small-btn secondary" onClick={() => remove(s.id)}>
                    {t("Изтрий")}
                  </button>
                </div>
              }
            >
              <div className="small muted" style={{ marginBottom: 10 }}>
                {s.baseUrl}
                {s.searchUrlTemplate && ` · ${s.searchUrlTemplate}`}
                <br />
                {t("Последно обновено")}: {s.lastRefreshedAt ? new Date(s.lastRefreshedAt).toLocaleString() : t("никога")}
                {s.lastTriggeredBy && ` ${t("от")} ${s.lastTriggeredBy}`}
                {s.lastMatchedCount !== null && ` (${s.lastMatchedCount} ${t("цени")})`}
                {s.lastError && (
                  <>
                    <br />
                    <span className="error-text">{s.lastError}</span>
                  </>
                )}
              </div>

              {tabs.length > 1 && (
                <div className="tabs compact">
                  {tabs.map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      className={openTab === tab.key ? "active" : "secondary"}
                      onClick={() => setOpenTab(tab.key)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              )}

              {openTab === "edit" && (
                <SourceForm
                  storeId={storeId}
                  source={s}
                  onDone={() => {
                    setOpenSourceId(null);
                    refresh();
                  }}
                  onCancel={() => setOpenSourceId(null)}
                />
              )}
              {openTab === "import" && s.type === "manual_import" && <ManualImportPanel source={s} onImported={refresh} />}
              {openTab === "results" && <ScrapeAttemptsPanel sourceId={s.id} sourceType={s.type} />}
              {openTab === "queue" && <AmbiguousMatchesPanel sourceId={s.id} />}
            </AccordionItem>
          );
        })}
        {sources.length === 0 && <p className="muted">{t("Все още няма източници.")}</p>}
      </div>

      {!addingSource && !openSourceId && sources.length < MAX_SOURCES_PER_STORE && (
        <button onClick={() => setAddingSource(true)}>{t("+ Добави източник")}</button>
      )}
      {sources.length >= MAX_SOURCES_PER_STORE && !addingSource && (
        <p className="muted small">{t("Максимум {max} източника на магазин.", { max: MAX_SOURCES_PER_STORE })}</p>
      )}
      {addingSource && (
        <div className="accordion-item">
          <div className="accordion-body" style={{ borderTop: "none" }}>
            <SourceForm
              storeId={storeId}
              source={null}
              onDone={() => {
                setAddingSource(false);
                refresh();
              }}
              onCancel={() => setAddingSource(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// Round-trips the CSV export/import for a `manual_import` source: some
// competitor sites block automated fetches outright, so instead of a live
// scraper, a Cowork agent (or a person) searches the site by hand and fills
// in prices on the exported template — no fuzzy product matching needed on
// re-import since every row already carries our own product_id.
function ManualImportPanel({ source, onImported }: { source: Source; onImported: () => void }) {
  const t = useT();
  const [downloading, setDownloading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ matched: number; notFoundCount: number; errorCount: number; errors: string[] } | null>(
    null
  );
  const [importingAmbiguous, setImportingAmbiguous] = useState(false);
  const [ambiguousResult, setAmbiguousResult] = useState<{ imported: number; errorCount: number; errors: string[] } | null>(
    null
  );

  async function downloadTemplate() {
    setDownloading(true);
    try {
      const res = await api<{ csv: string; filename: string }>(`/sources/${source.id}/export-template`);
      const blob = new Blob([res.csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filename;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  }

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setImporting(true);
    setResult(null);
    try {
      const res = await api<{ matched: number; notFoundCount: number; errorCount: number; errors: string[] }>(
        `/sources/${source.id}/import`,
        { method: "POST", body: JSON.stringify({ csv: text }) }
      );
      setResult(res);
      onImported();
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  }

  async function handleAmbiguousFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setImportingAmbiguous(true);
    setAmbiguousResult(null);
    try {
      const res = await api<{ imported: number; errorCount: number; errors: string[] }>(
        `/sources/${source.id}/import-ambiguous`,
        { method: "POST", body: JSON.stringify({ csv: text }) }
      );
      setAmbiguousResult(res);
      onImported();
    } finally {
      setImportingAmbiguous(false);
      e.target.value = "";
    }
  }

  return (
    <div>
      <p className="muted small">
        {t("1. Изтеглете шаблона за проучване (всеки продукт, плюс предложен URL за търсене). 2. Търсете {baseUrl} за всеки продукт и попълнете", {
          baseUrl: source.baseUrl,
        })}{" "}
        <code>competitor_price</code>
        {t(" (или отбележете")} <code>not_found</code>
        {t(") в същия файл. 3. Качете го обратно тук — редовете се съпоставят по")} <code>product_id</code>
        {t(", така че нищо тук не разчита заглавията да съвпадат точно.")}
      </p>
      <div className="form-row">
        <button className="small-btn secondary" onClick={downloadTemplate} disabled={downloading}>
          {downloading ? t("Подготовка…") : t("Изтегли шаблон")}
        </button>
        <input type="file" accept=".csv,text/csv" onChange={handleFile} disabled={importing} />
      </div>
      {result && (
        <div className="small" style={{ marginTop: 8 }}>
          {t("Импортирани {matched} цена/и, {notFound} отбелязани като ненамерени.", {
            matched: result.matched,
            notFound: result.notFoundCount,
          })}
          {result.errorCount > 0 && (
            <div className="error-text">
              {t("{count} ред(а) пропуснати: {errors}", { count: result.errorCount, errors: result.errors.join("; ") })}
            </div>
          )}
        </div>
      )}
      <p className="muted small" style={{ marginTop: 12 }}>
        {t("Ако при проучването сте открили кандидати, в които не сте сигурни, качете отделния файл за преглед (напр.")}{" "}
        <code>ambiguous_review.csv</code>
        {t(') тук — те ще се появят в раздел "Опашка за преглед" вместо да се налага да бъдат разрешавани ръчно в таблицата.')}
      </p>
      <div className="form-row">
        <input type="file" accept=".csv,text/csv" onChange={handleAmbiguousFile} disabled={importingAmbiguous} />
      </div>
      {ambiguousResult && (
        <div className="small" style={{ marginTop: 8 }}>
          {t("{count} продукт(и) добавени в опашката за преглед.", { count: ambiguousResult.imported })}
          {ambiguousResult.errorCount > 0 && (
            <div className="error-text">
              {t("{count} ред(а) пропуснати: {errors}", {
                count: ambiguousResult.errorCount,
                errors: ambiguousResult.errors.join("; "),
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScrapeAttemptsPanel({ sourceId, sourceType }: { sourceId: string; sourceType: SourceType }) {
  const t = useT();
  const [attempts, setAttempts] = useState<ScrapeAttempt[] | null>(null);

  useEffect(() => {
    setAttempts(null);
    api<ScrapeAttempt[]>(`/sources/${sourceId}/attempts`).then(setAttempts);
  }, [sourceId]);

  if (attempts === null) return <p className="muted small">{t("Зареждане…")}</p>;
  if (attempts.length === 0) {
    return (
      <p className="muted small">
        {sourceType === "manual_import"
          ? t("Все още няма импортирани резултати — превключете към раздел \"Импортиране\", изтеглете шаблона, попълнете го и го качете.")
          : t('Все още няма търсени продукти — първо натиснете "Обнови сега".')}
      </p>
    );
  }

  const foundCount = attempts.filter((a) => a.found).length;

  return (
    <div>
      <p className="muted small">
        {t("{found} от {total} {kind} продукта в момента имат цена от този източник.", {
          found: foundCount,
          total: attempts.length,
          kind: sourceType === "manual_import" ? t("проучени") : t("търсени"),
        })}
        {sourceType !== "manual_import" &&
          t(" Запазва се само последният опит за всеки продукт — не всеки продукт се търси при всяко изпълнение (вижте бележката за приоритет/ротация по-горе).")}
      </p>
      <div style={{ overflowX: "auto" }}>
        <table className="pricing-table">
          <thead>
            <tr>
              <th>{t("Продукт")}</th>
              <th>{t("Резултат")}</th>
              <th>{t("Цена")}</th>
              <th>{t("Кога")}</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.productVendor ? `${a.productVendor} — ` : ""}
                  {a.productTitle}
                  {a.productSku && <span className="muted small"> ({a.productSku})</span>}
                </td>
                <td>
                  {a.found ? (
                    <a href={a.url} target="_blank" rel="noreferrer">
                      {t("✓ намерено")}
                    </a>
                  ) : (
                    <span className="error-text" title={a.error ?? undefined}>
                      ✕ {a.error ?? t("не е намерено")}
                    </span>
                  )}
                </td>
                <td>{a.price !== null ? a.price.toFixed(2) : "—"}</td>
                <td>{new Date(a.attemptedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// jeftinije_hr found more than one plausible listing for these products and
// couldn't pick confidently on its own — one candidate confirmed here goes
// through the same recordFoundPrice() path a clean automatic match would,
// dismissing just marks it so the crawl doesn't keep re-surfacing it.
function AmbiguousMatchesPanel({ sourceId }: { sourceId: string }) {
  const t = useT();
  const [matches, setMatches] = useState<AmbiguousMatch[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh() {
    setMatches(await api<AmbiguousMatch[]>(`/sources/${sourceId}/ambiguous`));
  }

  useEffect(() => {
    setMatches(null);
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);

  async function confirm(matchId: string, candidate: { price: number | null; url: string }) {
    if (candidate.price === null) return;
    setBusyId(matchId);
    try {
      await api(`/sources/ambiguous/${matchId}/confirm`, {
        method: "POST",
        body: JSON.stringify({ price: candidate.price, url: candidate.url }),
      });
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function dismiss(matchId: string) {
    setBusyId(matchId);
    try {
      await api(`/sources/ambiguous/${matchId}/dismiss`, { method: "POST" });
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  if (matches === null) return <p className="muted small">{t("Зареждане…")}</p>;
  if (matches.length === 0) {
    return (
      <p className="muted small">
        {t("Няма нищо за преглед — всяко съпоставяне от последното сканиране е било или сигурно, или ненамерено.")}
      </p>
    );
  }

  return (
    <div>
      <p className="muted small">
        {t(
          "{count} продукт(и) с повече от едно вероятно обявление. Изберете правилното или отхвърлете, ако нито едно от тях не е реално съвпадение — отхвърлянето му пречи да се появи отново, освен ако сканирането не намери различни кандидати следващия път.",
          { count: matches.length }
        )}
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {matches.map((m) => (
          <div key={m.id} className="card" style={{ margin: 0 }}>
            <strong>
              {m.productVendor ? `${m.productVendor} — ` : ""}
              {m.productTitle}
            </strong>{" "}
            <span className="muted small">
              ({t("нашата цена")}: {m.ourPrice.toFixed(2)}
              {m.productSku ? `, ${m.productSku}` : ""})
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
              {m.candidates.map((c, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <button
                    className="small-btn secondary"
                    disabled={busyId === m.id || c.price === null}
                    onClick={() => confirm(m.id, c)}
                    title={c.price === null ? t("Няма цена в това обявление — не може да бъде потвърдено") : undefined}
                  >
                    {t("Използвай това")}
                  </button>
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {c.title}
                  </a>
                  <span className="muted small">{c.price !== null ? c.price.toFixed(2) : t("няма цена")}</span>
                  {c.sizeUnconfirmed && (
                    <span
                      className="small error-text"
                      title={t(
                        "Заглавието на това обявление не показва размер — цената по-горе може да е за различен вариант от нашия. Отворете връзката и проверете преди да я използвате."
                      )}
                    >
                      {t("⚠ размерът не е потвърден — проверете страницата преди да използвате")}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="small-btn secondary" disabled={busyId === m.id} onClick={() => dismiss(m.id)}>
                {t("Нито едно от тях — отхвърли")}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SourceForm({
  storeId,
  source,
  onDone,
  onCancel,
}: {
  storeId: string;
  source: Source | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const isEdit = Boolean(source);
  const [label, setLabel] = useState(source?.label ?? "");
  const [type, setType] = useState<SourceType>(source?.type ?? "shopify_json");
  const [baseUrl, setBaseUrl] = useState(source?.baseUrl ?? "");
  const [searchUrlTemplate, setSearchUrlTemplate] = useState(source?.searchUrlTemplate ?? "");
  const [active, setActive] = useState(source?.active ?? true);
  const [autoRefresh, setAutoRefresh] = useState(source?.autoRefresh ?? true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A brand-listing crawl is heavy enough that it must never silently
  // inherit "auto-refresh" from whatever the previous type defaulted to —
  // confirmed live that editing a source from manual_import (which defaults
  // autoRefresh to true) back to jeftinije_hr left the stale `true` in
  // place, since edits otherwise never override an existing explicit
  // choice, and the scheduler then kicked off an unwanted crawl on its next
  // 15-minute tick. So switching TO jeftinije_hr (or notino_hr, the same
  // style of brand-listing crawl) always forces it off, whether creating
  // new or editing — the one type where "quietly inherited true" is never
  // an acceptable state, in trade for the admin having to re-check the box
  // if they genuinely want it on.
  function handleTypeChange(next: SourceType) {
    setType(next);
    if (next === "jeftinije_hr" || next === "notino_hr") {
      setAutoRefresh(false);
      if (!baseUrl) setBaseUrl(next === "jeftinije_hr" ? "https://www.jeftinije.hr" : "https://www.notino.hr");
    } else if (!isEdit) {
      setAutoRefresh(true);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const body = {
        storeId,
        label,
        type,
        baseUrl,
        searchUrlTemplate:
          type === "shopify_json" || type === "jeftinije_hr" || type === "notino_hr" ? null : searchUrlTemplate || null,
        active,
        autoRefresh,
      };
      if (isEdit) await api(`/sources/${source!.id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/sources", { method: "POST", body: JSON.stringify(body) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form" style={{ marginBottom: 0 }} onSubmit={handleSubmit}>
      {isEdit && (
        <p className="small" style={{ margin: "0 0 4px" }}>
          {t('Промяната на URL/типа на този източник заменя самоличността му, не добавя нов. Използвайте "+ Добави източник", ако искате да следите друг сайт.')}
        </p>
      )}
      <div className="form-row">
        <label>
          {t("Име")}
          <input value={label} onChange={(e) => setLabel(e.target.value)} required />
        </label>
        <label>
          {t("Тип")}
          <select value={type} onChange={(e) => handleTypeChange(e.target.value as SourceType)}>
            <option value="shopify_json">{t("Shopify JSON (конкурентът използва Shopify)")}</option>
            <option value="scrape">{t("Сканиране (търсене + анализ)")}</option>
            <option value="manual_import">{t("Ръчно импортиране (проучване чрез Cowork → CSV)")}</option>
            <option value="jeftinije_hr">{t("jeftinije.hr (масово сканиране на брандове)")}</option>
            <option value="notino_hr">{t("notino.hr (сканиране по бранд — тест)")}</option>
          </select>
        </label>
      </div>
      <label>
        {t("Базов URL")}
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={type === "shopify_json" ? "https://competitor.com" : "https://competitor.com"}
          required
        />
      </label>
      {(type === "scrape" || type === "manual_import") && (
        <label>
          {t("Шаблон за URL за търсене")}{" "}
          {type === "manual_import" && <span className="muted">{t("(незадължително — отправна точка за проучващия)")}</span>}
          <input
            value={searchUrlTemplate}
            onChange={(e) => setSearchUrlTemplate(e.target.value)}
            placeholder="https://competitor.com/search?q={QUERY}"
          />
        </label>
      )}
      {type === "jeftinije_hr" && (
        <p className="muted small" style={{ margin: 0 }}>
          {t(
            "Сканира филтрираните по бранд страници на jeftinije.hr веднъж на изпълнение (без търсене по продукт) и съпоставя стриктно по бранд + мл + концентрация; всичко, което не е сигурно, отива в опашката за преглед вместо да се гадае."
          )}
        </p>
      )}
      {type === "notino_hr" && (
        <p className="muted small" style={{ margin: 0 }}>
          {t(
            "Тестов източник: сканира страницата с обяви на един бранд в notino.hr (в момента само DIOR — вижте BRAND_SLUGS в notinoScraper.ts за добавяне на още) и съпоставя по същия начин като jeftinije.hr."
          )}
        </p>
      )}
      <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        {t("Активен")}
      </label>
      <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
        {t('Автоматично обновяване на всеки 24ч (без отметка = само при натискане на "Обнови сега")')}
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? t("Запазване…") : isEdit ? t("Запази промените") : t("Добави източник")}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t("Отказ")}
        </button>
      </div>
    </form>
  );
}
