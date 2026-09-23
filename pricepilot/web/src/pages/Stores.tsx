import { useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Store } from "../api/types";
import { AccordionItem } from "../components/Accordion";
import { StoreForm } from "../components/StoreForm";
import { useStores } from "../context/StoreContext";
import { useT } from "../i18n/I18nContext";

const PROFILE_LABELS = { competitor: "Проследяване на конкуренти", cod_formula: "COD формула" } as const;

export function Stores() {
  const t = useT();
  const navigate = useNavigate();
  const { stores, groups, setCurrentStoreId, refreshStores, refreshGroups } = useStores();
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [addingGroup, setAddingGroup] = useState(false);
  const [addingStore, setAddingStore] = useState(false);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);

  function toggleGroup(id: string) {
    setRenamingGroupId(null);
    setExpandedGroupId((cur) => (cur === id ? null : id));
  }

  function openStore(store: Store) {
    setCurrentStoreId(store.id);
    navigate(`/stores/${store.id}`);
  }

  async function deleteGroup(id: string, name: string) {
    if (!window.confirm(t("Изтриване на групата „{name}“? Магазините в нея остават — просто стават без група.", { name })))
      return;
    await api(`/groups/${id}`, { method: "DELETE" });
    if (expandedGroupId === id) setExpandedGroupId(null);
    refreshGroups();
  }

  const storesByGroup = new Map<string, Store[]>();
  const ungrouped: Store[] = [];
  for (const s of stores) {
    if (s.groupId) {
      const list = storesByGroup.get(s.groupId) ?? [];
      list.push(s);
      storesByGroup.set(s.groupId, list);
    } else {
      ungrouped.push(s);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>{t("Магазини")}</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {!addingGroup && (
            <button className="secondary" onClick={() => setAddingGroup(true)}>
              {t("+ Добави група")}
            </button>
          )}
          {!addingStore && (
            <button
              onClick={() => {
                setExpandedGroupId(null);
                setAddingStore(true);
              }}
            >
              {t("+ Добави магазин")}
            </button>
          )}
        </div>
      </div>

      {addingGroup && (
        <div className="card" style={{ marginBottom: 16 }}>
          <AddGroupForm
            onDone={() => {
              setAddingGroup(false);
              refreshGroups();
            }}
            onCancel={() => setAddingGroup(false)}
          />
        </div>
      )}

      {addingStore && (
        <div className="card" style={{ marginBottom: 16 }}>
          <StoreForm
            store={null}
            onDone={() => {
              setAddingStore(false);
              refreshStores();
            }}
            onCancel={() => setAddingStore(false)}
          />
        </div>
      )}

      <div className="entity-list" style={{ marginBottom: 12 }}>
        {groups.map((g) => {
          const groupStores = storesByGroup.get(g.id) ?? [];
          return (
            <AccordionItem
              key={g.id}
              open={expandedGroupId === g.id}
              onToggle={() => toggleGroup(g.id)}
              headerLeft={
                <span>
                  {g.name}{" "}
                  <span className="accordion-meta">
                    {groupStores.length} {groupStores.length === 1 ? t("магазин") : t("магазина")}
                  </span>
                </span>
              }
              headerRight={
                <div className="entity-row-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="small-btn secondary" onClick={() => setRenamingGroupId(renamingGroupId === g.id ? null : g.id)}>
                    {t("Преименувай")}
                  </button>
                  <button className="small-btn secondary" onClick={() => deleteGroup(g.id, g.name)}>
                    {t("Изтрий")}
                  </button>
                </div>
              }
            >
              {renamingGroupId === g.id && (
                <RenameGroupForm
                  groupId={g.id}
                  currentName={g.name}
                  onDone={() => {
                    setRenamingGroupId(null);
                    refreshGroups();
                  }}
                  onCancel={() => setRenamingGroupId(null)}
                />
              )}
              <StoreRows stores={groupStores} onOpen={openStore} />
            </AccordionItem>
          );
        })}

        {(ungrouped.length > 0 || groups.length === 0) && (
          <AccordionItem
            open={expandedGroupId === "__ungrouped"}
            onToggle={() => toggleGroup("__ungrouped")}
            headerLeft={
              <span>
                {t("Без група")}{" "}
                <span className="accordion-meta">
                  {ungrouped.length} {ungrouped.length === 1 ? t("магазин") : t("магазина")}
                </span>
              </span>
            }
          >
            <StoreRows stores={ungrouped} onOpen={openStore} />
          </AccordionItem>
        )}
      </div>

      {groups.length === 0 && ungrouped.length === 0 && (
        <p className="muted">{t('Все още няма магазини — натиснете „+ Добави магазин“ по-горе.')}</p>
      )}
    </div>
  );
}

function StoreRows({ stores, onOpen }: { stores: Store[]; onOpen: (store: Store) => void }) {
  const t = useT();
  if (stores.length === 0) return <p className="muted small">{t("В тази група все още няма магазини.")}</p>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {stores.map((store) => (
        <StoreRow key={store.id} store={store} onOpen={() => onOpen(store)} />
      ))}
    </div>
  );
}

function StoreRow({ store, onOpen }: { store: Store; onOpen: () => void }) {
  const t = useT();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function testConnection() {
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

  return (
    <div className="entity-row">
      <div>
        <strong>{store.name}</strong>{" "}
        <span className="accordion-meta">
          {store.marketCode} · {store.currency} · {PROFILE_LABELS[store.pricingProfile]}
        </span>
        <div className="small muted">{store.myshopifyDomain}</div>
        {testResult && <div className="small">{testResult}</div>}
      </div>
      <div className="entity-row-actions">
        <button className="small-btn secondary" onClick={testConnection} disabled={testing}>
          {testing ? t("Тестване…") : t("Тествай връзката")}
        </button>
        <button className="small-btn" onClick={onOpen}>
          {t("Отвори →")}
        </button>
      </div>
    </div>
  );
}

function AddGroupForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api("/groups", { method: "POST", body: JSON.stringify({ name }) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form" style={{ marginBottom: 0 }} onSubmit={handleSubmit}>
      <label>
        {t("Име на групата")}
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("напр. Парфюми HR, COD магазини")}
          required
          autoFocus
        />
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? t("Добавяне…") : t("Добави група")}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t("Отказ")}
        </button>
      </div>
    </form>
  );
}

function RenameGroupForm({
  groupId,
  currentName,
  onDone,
  onCancel,
}: {
  groupId: string;
  currentName: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api(`/groups/${groupId}`, { method: "PATCH", body: JSON.stringify({ name }) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form-row" style={{ marginBottom: 14 }} onSubmit={handleSubmit}>
      <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus style={{ flex: 2 }} />
      <button type="submit" disabled={submitting}>
        {submitting ? t("Запазване…") : t("Запази")}
      </button>
      <button type="button" className="secondary" onClick={onCancel}>
        {t("Отказ")}
      </button>
      {error && <div className="error-text">{error}</div>}
    </form>
  );
}
