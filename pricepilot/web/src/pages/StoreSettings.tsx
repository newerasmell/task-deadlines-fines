import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { AccordionItem } from "../components/Accordion";
import { CostsImport } from "../components/CostsImport";
import { SourcesSection } from "../components/SourcesSection";
import { StoreForm } from "../components/StoreForm";
import { useStores } from "../context/StoreContext";

const PROFILE_LABELS = { competitor: "Competitor tracking", cod_formula: "COD formula" } as const;

// The dedicated per-store settings page — reached by picking a store on
// /stores. Loads only THAT store's connection/sources/costs, replacing the
// old single Settings page which stacked every store's config plus the
// full store list plus account/team management all on top of each other.
export function StoreSettings() {
  const { storeId } = useParams<{ storeId: string }>();
  const navigate = useNavigate();
  const { stores, groups, setCurrentStoreId, refreshStores, loading } = useStores();
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const store = stores.find((s) => s.id === storeId) ?? null;

  useEffect(() => {
    if (storeId) setCurrentStoreId(storeId);
  }, [storeId, setCurrentStoreId]);

  async function testConnection() {
    if (!store) return;
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
    if (!store) return;
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

  async function deleteStore() {
    if (!store) return;
    if (!window.confirm(`Delete store "${store.name}"? This removes its products, sources, and history too.`)) return;
    await api(`/stores/${store.id}`, { method: "DELETE" });
    await refreshStores();
    navigate("/stores");
  }

  if (loading) return <p className="center-loading">Loading…</p>;
  if (!store) {
    return (
      <div>
        <Link to="/stores">← Stores</Link>
        <p className="muted" style={{ marginTop: 12 }}>
          Store not found — it may have been deleted.
        </p>
      </div>
    );
  }

  const groupName = groups.find((g) => g.id === store.groupId)?.name ?? "Ungrouped";

  return (
    <div>
      <Link to="/stores" className="small">
        ← Stores
      </Link>

      <div className="page-header" style={{ marginTop: 8 }}>
        <div>
          <h1 style={{ marginBottom: 2 }}>{store.name}</h1>
          <span className="muted small">
            {groupName} · {store.marketCode} · {store.currency} · {PROFILE_LABELS[store.pricingProfile]}
          </span>
        </div>
        <div className="entity-row-actions">
          {testResult && <span className="small">{testResult}</span>}
          {syncResult && <span className="small">{syncResult}</span>}
          <button className="secondary" onClick={testConnection} disabled={testing}>
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button className="secondary" onClick={syncNow} disabled={syncing}>
            {syncing ? "Syncing…" : "Sync now"}
          </button>
          <button className="secondary" onClick={deleteStore}>
            Delete store
          </button>
        </div>
      </div>

      <div className="settings-section">
        <AccordionItem
          open={connectionOpen}
          onToggle={() => setConnectionOpen((v) => !v)}
          headerLeft={<span>Connection &amp; pricing rule</span>}
        >
          <StoreForm
            store={store}
            onDone={() => {
              setConnectionOpen(false);
              refreshStores();
            }}
            onCancel={() => setConnectionOpen(false)}
          />
        </AccordionItem>
      </div>

      <div className="settings-section">
        <h2>Sources</h2>
        <SourcesSection storeId={store.id} />
      </div>

      <div className="settings-section">
        <h2>Import costs</h2>
        <CostsImport storeId={store.id} />
      </div>
    </div>
  );
}
