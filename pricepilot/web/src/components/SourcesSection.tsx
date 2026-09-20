import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { api } from "../api/client";
import type { AmbiguousMatch, ScrapeAttempt, Source, SourceType } from "../api/types";
import { AccordionItem } from "./Accordion";

const MAX_SOURCES_PER_STORE = 4; // was 3 per the original brief; raised at the user's request

type SourceTab = "edit" | "import" | "results" | "queue";

function defaultTabFor(type: SourceType): SourceTab {
  if (type === "manual_import") return "import";
  if (type === "scrape") return "results";
  if (type === "jeftinije_hr" || type === "notino_hr") return "queue";
  return "edit";
}

function tabsFor(type: SourceType): { key: SourceTab; label: string }[] {
  const tabs: { key: SourceTab; label: string }[] = [{ key: "edit", label: "Edit" }];
  if (type === "manual_import") tabs.push({ key: "import", label: "Import" });
  if (type === "scrape" || type === "manual_import") tabs.push({ key: "results", label: "Results" });
  if (type === "jeftinije_hr" || type === "notino_hr" || type === "manual_import") tabs.push({ key: "queue", label: "Review queue" });
  return tabs;
}

export function SourcesSection({ storeId }: { storeId: string }) {
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
    setRefreshResult((cur) => ({ ...cur, [id]: "Started — scrape sources can take several minutes…" }));
    const requestedAt = Date.now();
    try {
      const res = await api<{ ok: boolean; started?: boolean; alreadyRunning?: boolean; error?: string }>(
        `/sources/${id}/refresh`,
        { method: "POST" }
      );
      if (!res.ok) {
        setRefreshResult((cur) => ({ ...cur, [id]: `✕ ${res.error ?? "Error"}` }));
        return;
      }
      if (res.alreadyRunning) {
        setRefreshResult((cur) => ({ ...cur, [id]: "Already refreshing — check back shortly." }));
        return;
      }
      await pollUntilRefreshed(id, requestedAt);
    } catch (err) {
      setRefreshResult((cur) => ({ ...cur, [id]: err instanceof Error ? `✕ ${err.message}` : "✕ Error" }));
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
          [id]: source.lastError ? `✕ ${source.lastError}` : `✓ ${source.lastMatchedCount ?? 0} prices fetched`,
        }));
        return;
      }
    }
    setRefreshResult((cur) => ({ ...cur, [id]: "Still running — check back later." }));
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this source? Its collected competitor prices go with it.")) return;
    await api(`/sources/${id}`, { method: "DELETE" });
    if (openSourceId === id) setOpenSourceId(null);
    refresh();
  }

  return (
    <div>
      <div className="entity-list" style={{ marginBottom: addingSource ? 12 : 0 }}>
        {sources.map((s) => {
          const open = openSourceId === s.id;
          const tabs = tabsFor(s.type);
          return (
            <AccordionItem
              key={s.id}
              open={open}
              onToggle={() => openSource(s)}
              headerLeft={
                <span>
                  {s.label} <span className="accordion-meta">({s.type})</span>
                  {s.degraded && <span className="tag">degraded</span>}
                  {!s.active && <span className="tag">inactive</span>}
                  {!s.autoRefresh && <span className="tag">manual only</span>}
                </span>
              }
              headerRight={
                <div className="entity-row-actions" onClick={(e) => e.stopPropagation()}>
                  {refreshResult[s.id] && <span className="small">{refreshResult[s.id]}</span>}
                  {s.type !== "manual_import" && (
                    <button className="small-btn secondary" onClick={() => refreshSource(s.id)} disabled={refreshing === s.id}>
                      {refreshing === s.id ? "Refreshing…" : "Refresh now"}
                    </button>
                  )}
                  <button className="small-btn secondary" onClick={() => remove(s.id)}>
                    Delete
                  </button>
                </div>
              }
            >
              <div className="small muted" style={{ marginBottom: 10 }}>
                {s.baseUrl}
                {s.searchUrlTemplate && ` · ${s.searchUrlTemplate}`}
                <br />
                Last refreshed: {s.lastRefreshedAt ? new Date(s.lastRefreshedAt).toLocaleString() : "never"}
                {s.lastTriggeredBy && ` by ${s.lastTriggeredBy}`}
                {s.lastMatchedCount !== null && ` (${s.lastMatchedCount} prices)`}
                {s.lastError && (
                  <>
                    <br />
                    <span className="error-text">{s.lastError}</span>
                  </>
                )}
              </div>

              {tabs.length > 1 && (
                <div className="tabs compact">
                  {tabs.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      className={openTab === t.key ? "active" : "secondary"}
                      onClick={() => setOpenTab(t.key)}
                    >
                      {t.label}
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
        {sources.length === 0 && <p className="muted">No sources yet.</p>}
      </div>

      {!addingSource && !openSourceId && sources.length < MAX_SOURCES_PER_STORE && (
        <button onClick={() => setAddingSource(true)}>+ Add source</button>
      )}
      {sources.length >= MAX_SOURCES_PER_STORE && !addingSource && (
        <p className="muted small">Maximum of {MAX_SOURCES_PER_STORE} sources per store.</p>
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
        1. Download the research template (every product, plus a suggested search URL). 2. Search {source.baseUrl} for
        each one and fill in <code>competitor_price</code> (or mark <code>not_found</code>) on the same file. 3.
        Upload it back here — rows are matched by <code>product_id</code>, so nothing here relies on titles lining
        up exactly.
      </p>
      <div className="form-row">
        <button className="small-btn secondary" onClick={downloadTemplate} disabled={downloading}>
          {downloading ? "Preparing…" : "Download template"}
        </button>
        <input type="file" accept=".csv,text/csv" onChange={handleFile} disabled={importing} />
      </div>
      {result && (
        <div className="small" style={{ marginTop: 8 }}>
          Imported {result.matched} price(s), {result.notFoundCount} marked not-found.
          {result.errorCount > 0 && (
            <div className="error-text">
              {result.errorCount} row(s) skipped: {result.errors.join("; ")}
            </div>
          )}
        </div>
      )}
      <p className="muted small" style={{ marginTop: 12 }}>
        If your research turned up candidates you weren't sure about, upload that separate review file (e.g.{" "}
        <code>ambiguous_review.csv</code>) here — they'll show up under the "Review queue" tab instead of needing to
        be resolved by hand in the spreadsheet.
      </p>
      <div className="form-row">
        <input type="file" accept=".csv,text/csv" onChange={handleAmbiguousFile} disabled={importingAmbiguous} />
      </div>
      {ambiguousResult && (
        <div className="small" style={{ marginTop: 8 }}>
          {ambiguousResult.imported} product(s) added to the review queue.
          {ambiguousResult.errorCount > 0 && (
            <div className="error-text">
              {ambiguousResult.errorCount} row(s) skipped: {ambiguousResult.errors.join("; ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ScrapeAttemptsPanel({ sourceId, sourceType }: { sourceId: string; sourceType: SourceType }) {
  const [attempts, setAttempts] = useState<ScrapeAttempt[] | null>(null);

  useEffect(() => {
    setAttempts(null);
    api<ScrapeAttempt[]>(`/sources/${sourceId}/attempts`).then(setAttempts);
  }, [sourceId]);

  if (attempts === null) return <p className="muted small">Loading…</p>;
  if (attempts.length === 0) {
    return (
      <p className="muted small">
        {sourceType === "manual_import"
          ? "No results imported yet — switch to the Import tab, download the template, fill it in, and upload it."
          : 'No products searched yet — click "Refresh now" first.'}
      </p>
    );
  }

  const foundCount = attempts.filter((a) => a.found).length;

  return (
    <div>
      <p className="muted small">
        {foundCount} of {attempts.length} {sourceType === "manual_import" ? "researched" : "searched"} products
        currently have a price from this source.
        {sourceType !== "manual_import" &&
          " Only the most recent attempt per product is kept — not every product is searched every run (see the priority/rotation note above)."}
      </p>
      <div style={{ overflowX: "auto" }}>
        <table className="pricing-table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Result</th>
              <th>Price</th>
              <th>When</th>
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
                      ✓ found
                    </a>
                  ) : (
                    <span className="error-text" title={a.error ?? undefined}>
                      ✕ {a.error ?? "not found"}
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

  if (matches === null) return <p className="muted small">Loading…</p>;
  if (matches.length === 0) {
    return <p className="muted small">Nothing to review — every match from the last crawl was either confident or not found.</p>;
  }

  return (
    <div>
      <p className="muted small">
        {matches.length} product(s) with more than one plausible listing. Pick the right one, or dismiss if none of
        them are actually a match — dismissing keeps it from reappearing unless the crawl finds different candidates
        next time.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {matches.map((m) => (
          <div key={m.id} className="card" style={{ margin: 0 }}>
            <strong>
              {m.productVendor ? `${m.productVendor} — ` : ""}
              {m.productTitle}
            </strong>{" "}
            <span className="muted small">
              (our price: {m.ourPrice.toFixed(2)}
              {m.productSku ? `, ${m.productSku}` : ""})
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
              {m.candidates.map((c, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <button
                    className="small-btn secondary"
                    disabled={busyId === m.id || c.price === null}
                    onClick={() => confirm(m.id, c)}
                    title={c.price === null ? "No price on this listing — can't confirm it" : undefined}
                  >
                    Use this
                  </button>
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {c.title}
                  </a>
                  <span className="muted small">{c.price !== null ? c.price.toFixed(2) : "no price"}</span>
                  {c.sizeUnconfirmed && (
                    <span className="small error-text" title="This listing's title didn't show a size — the price above may be for a different variant than ours. Open the link and check before using it.">
                      ⚠ size not confirmed — check page before using
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8 }}>
              <button className="small-btn secondary" disabled={busyId === m.id} onClick={() => dismiss(m.id)}>
                None of these — dismiss
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
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form" style={{ marginBottom: 0 }} onSubmit={handleSubmit}>
      {isEdit && (
        <p className="small" style={{ margin: "0 0 4px" }}>
          Changing this source's URL/type replaces its identity, not adds a new one. Use "+ Add source" instead if
          you meant to track another site.
        </p>
      )}
      <div className="form-row">
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} required />
        </label>
        <label>
          Type
          <select value={type} onChange={(e) => handleTypeChange(e.target.value as SourceType)}>
            <option value="shopify_json">Shopify JSON (competitor runs Shopify)</option>
            <option value="scrape">Scrape (search + parse)</option>
            <option value="manual_import">Manual import (Cowork research → CSV)</option>
            <option value="jeftinije_hr">jeftinije.hr (bulk brand-listing crawl)</option>
            <option value="notino_hr">notino.hr (per-brand listing crawl — test)</option>
          </select>
        </label>
      </div>
      <label>
        Base URL
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={type === "shopify_json" ? "https://competitor.com" : "https://competitor.com"}
          required
        />
      </label>
      {(type === "scrape" || type === "manual_import") && (
        <label>
          Search URL template {type === "manual_import" && <span className="muted">(optional — a starting point for whoever's researching)</span>}
          <input
            value={searchUrlTemplate}
            onChange={(e) => setSearchUrlTemplate(e.target.value)}
            placeholder="https://competitor.com/search?q={QUERY}"
          />
        </label>
      )}
      {type === "jeftinije_hr" && (
        <p className="muted small" style={{ margin: 0 }}>
          Crawls jeftinije.hr's brand-filtered listing pages once per run (no per-product search) and matches
          strictly against brand + ml + concentration; anything less than certain goes to the review queue instead
          of being guessed.
        </p>
      )}
      {type === "notino_hr" && (
        <p className="muted small" style={{ margin: 0 }}>
          Test source: crawls a single brand's listing page on notino.hr (currently just DIOR — see BRAND_SLUGS in
          notinoScraper.ts to add more) and matches the same way as jeftinije.hr.
        </p>
      )}
      <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Active
      </label>
      <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
        Auto-refresh every 24h (unchecked = only when someone clicks "Refresh now")
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : isEdit ? "Save changes" : "Add source"}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
