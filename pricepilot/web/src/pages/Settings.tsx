import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { api } from "../api/client";
import type { PricingStrategy, ScrapeAttempt, Source, SourceType, Store } from "../api/types";
import { useStores } from "../context/StoreContext";

export function Settings() {
  const { stores, currentStore, refreshStores } = useStores();
  const [showStoreForm, setShowStoreForm] = useState(false);
  const [editingStore, setEditingStore] = useState<Store | null>(null);

  return (
    <div>
      <div className="page-header">
        <h1>Settings</h1>
      </div>

      <div className="settings-section">
        <h2>Stores</h2>
        <div className="entity-list">
          {stores.map((store) => (
            <StoreRow key={store.id} store={store} onEdit={() => setEditingStore(store)} onChanged={refreshStores} />
          ))}
        </div>
        {!showStoreForm && !editingStore && (
          <button onClick={() => setShowStoreForm(true)}>+ Add store</button>
        )}
        {(showStoreForm || editingStore) && (
          <StoreForm
            store={editingStore}
            onDone={() => {
              setShowStoreForm(false);
              setEditingStore(null);
              refreshStores();
            }}
            onCancel={() => {
              setShowStoreForm(false);
              setEditingStore(null);
            }}
          />
        )}
      </div>

      {currentStore && (
        <>
          <div className="settings-section">
            <h2>Sources — {currentStore.name}</h2>
            <SourcesSection storeId={currentStore.id} />
          </div>

          <div className="settings-section">
            <h2>Import costs — {currentStore.name}</h2>
            <CostsImport storeId={currentStore.id} />
          </div>
        </>
      )}
    </div>
  );
}

function StoreRow({ store, onEdit, onChanged }: { store: Store; onEdit: () => void; onChanged: () => void }) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await api<{ ok: boolean; shopName?: string; error?: string }>(`/stores/${store.id}/test-connection`, {
        method: "POST",
      });
      setTestResult(res.ok ? `✓ Connected to "${res.shopName}"` : `✕ ${res.error}`);
    } finally {
      setTesting(false);
    }
  }

  async function syncNow() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await api<{ ok: boolean; variantCount?: number; method?: string; error?: string }>(`/stores/${store.id}/sync-now`, {
        method: "POST",
      });
      setSyncResult(res.ok ? `✓ Synced ${res.variantCount} variants (${res.method})` : `✕ ${res.error}`);
    } finally {
      setSyncing(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete store "${store.name}"? This removes its products, sources, and history too.`)) return;
    await api(`/stores/${store.id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <div className="entity-row">
      <div>
        <strong>{store.name}</strong> <span className="muted small">({store.marketCode} · {store.currency})</span>
        <div className="small muted">{store.myshopifyDomain}</div>
        <div className="small muted">
          {store.pricingStrategy}, undercut {store.undercutPct}%, ending {store.priceEnding ?? "none"}, margin floor{" "}
          {store.minMarginPct}%
        </div>
        {testResult && <div className="small">{testResult}</div>}
        {syncResult && <div className="small">{syncResult}</div>}
      </div>
      <div className="entity-row-actions">
        <button className="small-btn secondary" onClick={testConnection} disabled={testing}>
          {testing ? "Testing…" : "Test connection"}
        </button>
        <button className="small-btn secondary" onClick={syncNow} disabled={syncing}>
          {syncing ? "Syncing…" : "Sync now"}
        </button>
        <button className="small-btn secondary" onClick={onEdit}>
          Edit
        </button>
        <button className="small-btn secondary" onClick={remove}>
          Delete
        </button>
      </div>
    </div>
  );
}

function StoreForm({ store, onDone, onCancel }: { store: Store | null; onDone: () => void; onCancel: () => void }) {
  const isEdit = Boolean(store);
  const [name, setName] = useState(store?.name ?? "");
  const [domain, setDomain] = useState(store?.myshopifyDomain ?? "");
  const [clientId, setClientId] = useState(store?.shopifyClientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [marketCode, setMarketCode] = useState(store?.marketCode ?? "");
  const [currency, setCurrency] = useState(store?.currency ?? "EUR");
  const [strategy, setStrategy] = useState<PricingStrategy>(store?.pricingStrategy ?? "undercut_min");
  const [undercutPct, setUndercutPct] = useState(String(store?.undercutPct ?? 1));
  const [priceEnding, setPriceEnding] = useState(store?.priceEnding ?? "");
  const [minMarginPct, setMinMarginPct] = useState(String(store?.minMarginPct ?? 10));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isEdit && !clientSecret.trim()) {
      setError("Client secret is required.");
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name,
        myshopifyDomain: domain,
        shopifyClientId: clientId.trim(),
        marketCode,
        currency,
        pricingStrategy: strategy,
        undercutPct: Number(undercutPct),
        priceEnding: priceEnding.trim() || null,
        minMarginPct: Number(minMarginPct),
      };
      if (clientSecret.trim()) body.shopifyClientSecret = clientSecret.trim();

      if (isEdit) await api(`/stores/${store!.id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/stores", { method: "POST", body: JSON.stringify(body) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <div className="form-row">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          myshopify.com domain
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="your-store.myshopify.com"
            required
          />
        </label>
      </div>
      <div className="form-row">
        <label>
          Client ID
          <input value={clientId} onChange={(e) => setClientId(e.target.value)} required />
        </label>
        <label>
          Client secret {isEdit && <span className="muted">(leave blank to keep the current one)</span>}
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="shpss_…"
          />
        </label>
      </div>
      <p className="muted small">
        From your app's Dev Dashboard page (dev.shopify.com) → Settings → Credentials. Requires{" "}
        <code>read_products</code> and <code>write_products</code> scopes, installed to this store.
      </p>
      <div className="form-row">
        <label>
          Market code
          <input value={marketCode} onChange={(e) => setMarketCode(e.target.value)} placeholder="e.g. PL, GR, BG" required />
        </label>
        <label>
          Currency
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="e.g. EUR" required />
        </label>
      </div>
      <div className="form-row">
        <label>
          Pricing strategy
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as PricingStrategy)}>
            <option value="undercut_min">Undercut lowest</option>
            <option value="match_min">Match lowest</option>
            <option value="undercut_avg">Undercut average</option>
          </select>
        </label>
        <label>
          Undercut %
          <input type="number" step="0.1" value={undercutPct} onChange={(e) => setUndercutPct(e.target.value)} />
        </label>
      </div>
      <div className="form-row">
        <label>
          Price ending (optional)
          <input value={priceEnding} onChange={(e) => setPriceEnding(e.target.value)} placeholder=".99" />
        </label>
        <label>
          Min margin % (floor guard)
          <input type="number" step="0.1" value={minMarginPct} onChange={(e) => setMinMarginPct(e.target.value)} />
        </label>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : isEdit ? "Save changes" : "Add store"}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const MAX_SOURCES_PER_STORE = 4; // was 3 per the original brief; raised at the user's request

function SourcesSection({ storeId }: { storeId: string }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Source | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [refreshResult, setRefreshResult] = useState<Record<string, string>>({});
  const [showAttempts, setShowAttempts] = useState<string | null>(null);

  async function refresh(): Promise<Source[]> {
    const list = await api<Source[]>(`/sources?storeId=${storeId}`);
    setSources(list);
    return list;
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

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
    refresh();
  }

  return (
    <div>
      <div className="entity-list">
        {sources.map((s) => (
          <div key={s.id}>
            <div className="entity-row">
              <div>
                <strong>{s.label}</strong> <span className="muted small">({s.type})</span>
                {s.degraded && <span className="tag">degraded</span>}
                {!s.active && <span className="tag">inactive</span>}
                <div className="small muted">{s.baseUrl}</div>
                {s.searchUrlTemplate && <div className="small muted">{s.searchUrlTemplate}</div>}
                <div className="small muted">
                  Last refreshed: {s.lastRefreshedAt ? new Date(s.lastRefreshedAt).toLocaleString() : "never"}
                  {s.lastMatchedCount !== null && ` (${s.lastMatchedCount} prices)`}
                </div>
                {s.lastError && <div className="small error-text">{s.lastError}</div>}
                {refreshResult[s.id] && <div className="small">{refreshResult[s.id]}</div>}
              </div>
              <div className="entity-row-actions">
                <button className="small-btn secondary" onClick={() => refreshSource(s.id)} disabled={refreshing === s.id}>
                  {refreshing === s.id ? "Refreshing…" : "Refresh now"}
                </button>
                {s.type === "scrape" && (
                  <button
                    className="small-btn secondary"
                    onClick={() => setShowAttempts(showAttempts === s.id ? null : s.id)}
                  >
                    {showAttempts === s.id ? "Hide results" : "View results"}
                  </button>
                )}
                <button className="small-btn secondary" onClick={() => setEditing(s)}>
                  Edit
                </button>
                <button className="small-btn secondary" onClick={() => remove(s.id)}>
                  Delete
                </button>
              </div>
            </div>
            {showAttempts === s.id && <ScrapeAttemptsPanel sourceId={s.id} />}
          </div>
        ))}
        {sources.length === 0 && <p className="muted">No sources yet.</p>}
      </div>
      {!showForm && !editing && sources.length < MAX_SOURCES_PER_STORE && (
        <button onClick={() => setShowForm(true)}>+ Add source</button>
      )}
      {sources.length >= MAX_SOURCES_PER_STORE && !editing && (
        <p className="muted small">Maximum of {MAX_SOURCES_PER_STORE} sources per store.</p>
      )}
      {(showForm || editing) && (
        <SourceForm
          storeId={storeId}
          source={editing}
          onDone={() => {
            setShowForm(false);
            setEditing(null);
            refresh();
          }}
          onCancel={() => {
            setShowForm(false);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function ScrapeAttemptsPanel({ sourceId }: { sourceId: string }) {
  const [attempts, setAttempts] = useState<ScrapeAttempt[] | null>(null);

  useEffect(() => {
    api<ScrapeAttempt[]>(`/sources/${sourceId}/attempts`).then(setAttempts);
  }, [sourceId]);

  if (attempts === null) return <p className="muted small">Loading…</p>;
  if (attempts.length === 0) {
    return <p className="muted small">No products searched yet — click "Refresh now" first.</p>;
  }

  const foundCount = attempts.filter((a) => a.found).length;

  return (
    <div className="card" style={{ marginTop: 4, marginBottom: 12 }}>
      <p className="muted small">
        {foundCount} of {attempts.length} searched products currently have a price from this source. Only the most
        recent attempt per product is kept — not every product is searched every run (see the priority/rotation
        note above).
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
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
        searchUrlTemplate: type === "scrape" ? searchUrlTemplate || null : null,
        active,
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
    <form className="card form" onSubmit={handleSubmit}>
      <div className="form-row">
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} required />
        </label>
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value as SourceType)}>
            <option value="shopify_json">Shopify JSON (competitor runs Shopify)</option>
            <option value="scrape">Scrape (search + parse)</option>
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
      {type === "scrape" && (
        <label>
          Search URL template
          <input
            value={searchUrlTemplate}
            onChange={(e) => setSearchUrlTemplate(e.target.value)}
            placeholder="https://competitor.com/search?q={EAN}"
          />
        </label>
      )}
      <label style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Active
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

function CostsImport({ storeId }: { storeId: string }) {
  const [result, setResult] = useState<{ imported: number; errorCount: number; errors: string[] } | null>(null);
  const [importing, setImporting] = useState(false);

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setImporting(true);
    setResult(null);
    try {
      const res = await api<{ imported: number; errorCount: number; errors: string[] }>("/costs/import", {
        method: "POST",
        body: JSON.stringify({ storeId, csv: text }),
      });
      setResult(res);
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  }

  return (
    <div className="card">
      <p className="muted small">
        CSV with two columns: SKU or EAN, then cost (a header row is optional). Used for the margin floor guard — products
        without a cost on file fall back to a percentage of the current price instead.
      </p>
      <input type="file" accept=".csv,text/csv" onChange={handleFile} disabled={importing} />
      {result && (
        <div className="small" style={{ marginTop: 8 }}>
          Imported {result.imported} rows.
          {result.errorCount > 0 && (
            <div className="error-text">
              {result.errorCount} row(s) skipped: {result.errors.join("; ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
