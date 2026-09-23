import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client";
import { AccordionItem } from "../components/Accordion";
import { CostsImport } from "../components/CostsImport";
import { SourcesSection } from "../components/SourcesSection";
import { StoreForm } from "../components/StoreForm";
import { useStores } from "../context/StoreContext";
import { useT } from "../i18n/I18nContext";

const PROFILE_LABELS = { competitor: "Проследяване на конкуренти", cod_formula: "COD формула" } as const;

// The dedicated per-store settings page — reached by picking a store on
// /stores. Loads only THAT store's connection/sources/costs, replacing the
// old single Settings page which stacked every store's config plus the
// full store list plus account/team management all on top of each other.
export function StoreSettings() {
  const t = useT();
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
      setTestResult(
        res.ok ? t('✓ Свързано с „{shopName}“', { shopName: res.shopName ?? "" }) : t("✕ {error}", { error: res.error ?? "" })
      );
    } finally {
      setTesting(false);
    }
  }

  async function syncNow() {
    if (!store) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await api<{ ok: boolean; variantCount?: number; method?: string; removedCount?: number; error?: string }>(
        `/stores/${store.id}/sync-now`,
        { method: "POST" }
      );
      setSyncResult(
        res.ok
          ? t("✓ Синхронизирани {count} варианта ({method}){removed}", {
              count: res.variantCount ?? 0,
              method: res.method ?? "",
              removed: res.removedCount ? t(" · премахнати {n} остарели", { n: res.removedCount }) : "",
            })
          : t("✕ {error}", { error: res.error ?? "" })
      );
    } finally {
      setSyncing(false);
    }
  }

  async function deleteStore() {
    if (!store) return;
    if (
      !window.confirm(
        t("Изтриване на магазин „{name}“? Това ще премахне и продуктите, източниците и историята му.", { name: store.name })
      )
    )
      return;
    await api(`/stores/${store.id}`, { method: "DELETE" });
    await refreshStores();
    navigate("/stores");
  }

  if (loading) return <p className="center-loading">{t("Зареждане…")}</p>;
  if (!store) {
    return (
      <div>
        <Link to="/stores">{t("← Магазини")}</Link>
        <p className="muted" style={{ marginTop: 12 }}>
          {t("Магазинът не е намерен — може да е бил изтрит.")}
        </p>
      </div>
    );
  }

  const groupName = groups.find((g) => g.id === store.groupId)?.name ?? t("Без група");

  return (
    <div>
      <Link to="/stores" className="small">
        {t("← Магазини")}
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
            {testing ? t("Тестване…") : t("Тествай връзката")}
          </button>
          <button className="secondary" onClick={syncNow} disabled={syncing}>
            {syncing ? t("Синхронизиране…") : t("Синхронизирай сега")}
          </button>
          <button className="secondary" onClick={deleteStore}>
            {t("Изтрий магазина")}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <AccordionItem
          open={connectionOpen}
          onToggle={() => setConnectionOpen((v) => !v)}
          headerLeft={<span>{t("Връзка и правило за ценообразуване")}</span>}
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
        <h2>{t("Източници")}</h2>
        <SourcesSection storeId={store.id} />
      </div>

      <div className="settings-section">
        <h2>{t("Импортирай себестойности")}</h2>
        <CostsImport storeId={store.id} />
      </div>
    </div>
  );
}
