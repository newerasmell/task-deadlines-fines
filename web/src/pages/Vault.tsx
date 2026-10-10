import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError } from "../api/client";
import type {
  User,
  VaultEntry,
  VaultEntryData,
  VaultHistoryRow,
  VaultTableMemberInfo,
  VaultTableSummary,
  VaultUserKeyInfo,
  VaultUserPublicKey,
} from "../api/types";
import { Avatar } from "../components/Avatar";
import { IconCopy, IconEdit, IconExternalLink, IconEye, IconEyeOff, IconLock, IconSearch, IconTrash } from "../components/icons";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";
import {
  PBKDF2_ITERATIONS,
  decryptJson,
  deriveStretchedKey,
  encryptJson,
  exportPublicKeyB64,
  generateKeyPair,
  generateSaltB64,
  generateVaultKey,
  importPublicKeyB64,
  unwrapPrivateKey,
  unwrapTableKey,
  wrapPrivateKey,
  wrapTableKey,
} from "../lib/vaultCrypto";
import type { ParsedTable, VaultField } from "../lib/vaultImport";
import { VAULT_FIELDS, guessColumnMapping, parseImportFile } from "../lib/vaultImport";

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

interface DecryptedEntry {
  id: string;
  data: VaultEntryData;
  createdBy: { id: string; name: string };
  createdAt: string;
}

function generateStrongPassword(length = 20): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

// `privateKey` lives only in this component's state — it is NEVER written
// to localStorage/sessionStorage/cookies, so navigating away from this page
// (unmounting it) or reloading the browser re-locks every table automatically.
// It's this person's RSA private key, unwrapped from their own master
// password; every table they belong to has its table key (TK) wrapped
// under their PUBLIC key, so this one private key unwraps all of them —
// one password for everything, while each table's entries stay encrypted
// under their own, cryptographically distinct TK (access to one table
// never implies access to another). Crucially, nobody else's browser ever
// needs this person's password to grant them a table: the granter only
// ever needs this person's PUBLIC key (not secret, fetched from the
// server) — see web/src/lib/vaultCrypto.ts for the actual RSA-OAEP calls.
export function Vault() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [myKeyInfo, setMyKeyInfo] = useState<VaultUserKeyInfo | null>(null);
  const [tables, setTables] = useState<VaultTableSummary[] | null>(null);
  const [activeUsers, setActiveUsers] = useState<User[]>([]);
  const [privateKey, setPrivateKey] = useState<CryptoKey | null>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [showCreateTable, setShowCreateTable] = useState(false);

  async function refreshTables() {
    setTables(await api<VaultTableSummary[]>("/vault/tables"));
  }

  useEffect(() => {
    Promise.all([
      api<VaultUserKeyInfo | null>("/vault/my-key").then(setMyKeyInfo),
      refreshTables(),
      api<User[]>("/users").then((all) => setActiveUsers(all.filter((u) => u.active))),
    ]).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fully self-service: nobody — not an admin, not anyone — ever needs to
  // be involved for a person to set this up. The password typed here never
  // leaves this browser in any form; only the derived public key does.
  async function handleSetupKey(password: string) {
    const salt = generateSaltB64();
    const stretched = await deriveStretchedKey(password, salt, PBKDF2_ITERATIONS);
    const keyPair = await generateKeyPair();
    const publicKey = await exportPublicKeyB64(keyPair.publicKey);
    const { wrappedPrivateKey, wrappedPrivateKeyIv } = await wrapPrivateKey(keyPair.privateKey, stretched);
    await api("/vault/my-key", {
      method: "POST",
      body: JSON.stringify({ salt, iterations: PBKDF2_ITERATIONS, publicKey, wrappedPrivateKey, wrappedPrivateKeyIv }),
    });
    setMyKeyInfo({ salt, iterations: PBKDF2_ITERATIONS, publicKey, wrappedPrivateKey, wrappedPrivateKeyIv });
    setPrivateKey(keyPair.privateKey);
  }

  async function handleUnlock(password: string) {
    if (!myKeyInfo) return;
    setUnlockError(null);
    setUnlocking(true);
    try {
      const stretched = await deriveStretchedKey(password, myKeyInfo.salt, myKeyInfo.iterations);
      const pk = await unwrapPrivateKey(myKeyInfo.wrappedPrivateKey, myKeyInfo.wrappedPrivateKeyIv, stretched);
      setPrivateKey(pk);
    } catch {
      setUnlockError(t("Грешна master парола."));
    } finally {
      setUnlocking(false);
    }
  }

  async function handleCreateTable(name: string, description: string) {
    if (!myKeyInfo) return;
    const tk = await generateVaultKey();
    const ownPublicKey = await importPublicKeyB64(myKeyInfo.publicKey);
    const wrappedKey = await wrapTableKey(tk, ownPublicKey);
    const created = await api<{ id: string; name: string; description: string | null }>("/vault/tables", {
      method: "POST",
      body: JSON.stringify({ name, description: description || undefined, wrappedKey }),
    });
    await refreshTables();
    setShowCreateTable(false);
    setSelectedTableId(created.id);
  }

  if (loading) return <p>{t("Зареждане…")}</p>;

  const admins = activeUsers.filter((u) => u.isSuperAdmin);

  return (
    <div>
      <div className="page-header">
        <h1>{t("Vault")}</h1>
        {privateKey && !selectedTableId && (
          <button
            className="secondary"
            onClick={() => {
              setPrivateKey(null);
              setSelectedTableId(null);
            }}
          >
            {t("Заключи")}
          </button>
        )}
      </div>
      <p className="muted">
        {t(
          "Криптирана база за пароли, логини и чувствителна информация, разделена на отделни таблици (напр. по екип/отдел) — zero-knowledge: криптирането/декриптирането става в браузъра ти, сървърът никога не вижда plaintext данните нито master паролата ти. Една master парола отключва всички таблици, до които имаш достъп. Отделна е от паролата ти за влизане в TODF."
        )}
      </p>

      {!myKeyInfo && <VaultSetupKeyForm onSubmit={handleSetupKey} />}

      {myKeyInfo && !privateKey && <VaultUnlockForm onSubmit={handleUnlock} error={unlockError} submitting={unlocking} />}

      {privateKey && !selectedTableId && (
        <div>
          <div className="vault-toolbar">
            <span className="spacer" />
            {user?.isSuperAdmin && (
              <button onClick={() => setShowCreateTable((s) => !s)}>{showCreateTable ? t("Затвори") : t("+ Нова таблица")}</button>
            )}
          </div>

          {showCreateTable && <VaultCreateTableForm onSubmit={handleCreateTable} />}

          {(tables ?? []).length === 0 ? (
            <p className="muted">
              {t("Все още няма таблици.")}
              {!user?.isSuperAdmin && admins.length > 0 && (
                <>
                  {" "}
                  {t("Помоли някой Ultimate Admin да ти предостави достъп — вече не им трябва нищо от теб за това.")}
                </>
              )}
            </p>
          ) : (
            <div className="vault-list">
              {(tables ?? []).map((tb) => (
                <div className="vault-item" key={tb.id}>
                  <Avatar id={tb.id} name={tb.name} size={36} />
                  <div className="vault-item-main">
                    <div className="vault-item-title">{tb.name}</div>
                    <div className="vault-item-sub muted small">
                      {tb.description ? `${tb.description} · ` : ""}
                      {tb.memberCount === 1 ? t("1 човек с достъп") : t("{count} души с достъп", { count: tb.memberCount })}
                    </div>
                  </div>
                  <div className="vault-item-actions">
                    {tb.isMember ? (
                      <button className="small-btn" onClick={() => setSelectedTableId(tb.id)}>
                        {t("Отвори")}
                      </button>
                    ) : user?.isSuperAdmin ? (
                      <button className="small-btn secondary" onClick={() => setSelectedTableId(tb.id)}>
                        {t("Нямаш достъп")}
                      </button>
                    ) : (
                      <span className="badge badge-info">{t("Нямаш достъп")}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {privateKey && selectedTableId && (
        <VaultTableView
          key={selectedTableId}
          table={(tables ?? []).find((tb) => tb.id === selectedTableId)!}
          allTables={tables ?? []}
          privateKey={privateKey}
          isSuperAdmin={!!user?.isSuperAdmin}
          currentUserId={user!.id}
          candidates={activeUsers}
          onBack={() => setSelectedTableId(null)}
          onTablesChanged={refreshTables}
        />
      )}
    </div>
  );
}

function VaultSetupKeyForm({ onSubmit }: { onSubmit: (password: string) => Promise<void> }) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 10) {
      setError(t("Master паролата трябва да е поне 10 символа."));
      return;
    }
    if (password !== confirm) {
      setError(t("Паролите не съвпадат."));
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form vault-gate" onSubmit={handleSubmit}>
      <div className="vault-gate-icon">
        <IconLock size={26} />
      </div>
      <p>
        <strong>{t("Задай си личен vault ключ")}</strong>
      </p>
      <p className="muted small">
        {t(
          "Задай master парола — тя никога не се изпраща към сървъра, никой друг никога не я вижда или въвежда вместо теб, и не може да бъде възстановена от никого, ако я забравиш. Избери нещо отделно от паролата ти за влизане в TODF. Щом го направиш, Ultimate Admin може да ти даде достъп до таблица по всяко време — без да е нужно присъствието ти или да споделяш нищо с него."
        )}
      </p>
      <div className="vault-gate-fields">
        <label>
          {t("Master парола")}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        </label>
        <label>
          {t("Потвърди паролата")}
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {error && <div className="error-text">{error}</div>}
        <button type="submit" disabled={submitting}>
          {submitting ? t("Записване…") : t("Задай ключ")}
        </button>
      </div>
    </form>
  );
}

function VaultUnlockForm({
  onSubmit,
  error,
  submitting,
}: {
  onSubmit: (password: string) => Promise<void>;
  error: string | null;
  submitting: boolean;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    await onSubmit(password);
  }

  return (
    <form className="card form vault-gate" onSubmit={handleSubmit}>
      <div className="vault-gate-icon">
        <IconLock size={26} />
      </div>
      <p>
        <strong>{t("Отключи vault-а")}</strong>
      </p>
      <div className="vault-gate-fields">
        <label>
          {t("Master парола")}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        </label>
        {error && <div className="error-text">{error}</div>}
        <button type="submit" disabled={submitting}>
          {submitting ? t("Отключване…") : t("Отключи")}
        </button>
      </div>
    </form>
  );
}

function VaultCreateTableForm({ onSubmit }: { onSubmit: (name: string, description: string) => Promise<void> }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError(t("Името на таблицата е задължително."));
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(name.trim(), description.trim());
      setName("");
      setDescription("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <div className="form-row">
        <label>
          {t("Име на таблицата")}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Напр. Маркетинг")} required autoFocus />
        </label>
        <label>
          {t("Описание (по избор)")}
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>
      {error && <div className="error-text">{error}</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? t("Записване…") : t("Създай таблица")}
      </button>
    </form>
  );
}

const HISTORY_ACTION_LABELS: Record<VaultHistoryRow["action"], string> = {
  CREATED: "Създаден",
  UPDATED: "Редактиран",
  DELETED: "Изтрит",
};

interface DecryptedHistoryRow {
  id: string;
  action: VaultHistoryRow["action"];
  actorName: string;
  createdAt: string;
  title: string;
}

function VaultTableView({
  table,
  allTables,
  privateKey,
  isSuperAdmin,
  currentUserId,
  candidates,
  onBack,
  onTablesChanged,
}: {
  table: VaultTableSummary;
  allTables: VaultTableSummary[];
  privateKey: CryptoKey;
  isSuperAdmin: boolean;
  currentUserId: string;
  candidates: User[];
  onBack: () => void;
  onTablesChanged: () => Promise<void>;
}) {
  const { t, lang } = useI18n();
  const locale = lang === "en" ? "en-GB" : "bg-BG";
  const [tableKey, setTableKey] = useState<CryptoKey | null>(null);
  const [entries, setEntries] = useState<DecryptedEntry[] | null>(null);
  const [tab, setTab] = useState<"entries" | "access" | "history">(table.isMember ? "entries" : "access");
  const [showAddForm, setShowAddForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [members, setMembers] = useState<VaultTableMemberInfo[] | null>(null);
  const [history, setHistory] = useState<DecryptedHistoryRow[] | null>(null);

  async function loadAndDecryptEntries(key: CryptoKey) {
    const raw = await api<VaultEntry[]>(`/vault/tables/${table.id}/entries`);
    const decrypted: DecryptedEntry[] = [];
    for (const e of raw) {
      try {
        const data = await decryptJson<VaultEntryData>(key, e.ciphertext, e.iv);
        decrypted.push({ id: e.id, data, createdBy: e.createdBy, createdAt: e.createdAt });
      } catch {
        // Would only happen for a row encrypted under a different TK — skip
        // rather than crash the page.
      }
    }
    setEntries(decrypted);
  }

  useEffect(() => {
    if (!table.isMember || !table.myWrap) return;
    unwrapTableKey(table.myWrap.wrappedKey, privateKey).then((tk) => {
      setTableKey(tk);
      loadAndDecryptEntries(tk);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table.id]);

  async function refreshMembers() {
    setMembers(await api<VaultTableMemberInfo[]>(`/vault/tables/${table.id}/members`));
  }

  useEffect(() => {
    if (tab === "access" && isSuperAdmin) refreshMembers();
    if (tab === "history" && tableKey) loadHistory(tableKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, tableKey]);

  async function loadHistory(key: CryptoKey) {
    const raw = await api<VaultHistoryRow[]>(`/vault/tables/${table.id}/history`);
    const decorated: DecryptedHistoryRow[] = [];
    for (const row of raw) {
      let title = t("(неразчитаем запис)");
      try {
        const data = await decryptJson<VaultEntryData>(key, row.entry.ciphertext, row.entry.iv);
        title = data.title || title;
      } catch {
        // leave the fallback label
      }
      decorated.push({ id: row.id, action: row.action, actorName: row.actorName, createdAt: row.createdAt, title });
    }
    setHistory(decorated);
  }

  async function saveEntry(data: VaultEntryData, existingId?: string) {
    if (!tableKey) return;
    const { ciphertext, iv } = await encryptJson(tableKey, data);
    if (existingId) {
      await api(`/vault/tables/${table.id}/entries/${existingId}`, { method: "PATCH", body: JSON.stringify({ ciphertext, iv }) });
    } else {
      await api(`/vault/tables/${table.id}/entries`, { method: "POST", body: JSON.stringify({ ciphertext, iv }) });
    }
    await loadAndDecryptEntries(tableKey);
  }

  async function importEntries(dataList: VaultEntryData[], onProgress: (done: number, total: number) => void): Promise<{ failed: number }> {
    if (!tableKey) return { failed: dataList.length };
    let failed = 0;
    for (let i = 0; i < dataList.length; i++) {
      try {
        const { ciphertext, iv } = await encryptJson(tableKey, dataList[i]);
        await api(`/vault/tables/${table.id}/entries`, { method: "POST", body: JSON.stringify({ ciphertext, iv }) });
      } catch {
        failed++;
      }
      onProgress(i + 1, dataList.length);
    }
    await loadAndDecryptEntries(tableKey);
    return { failed };
  }

  async function deleteEntry(id: string) {
    if (!window.confirm(t("Наистина ли да изтрия този запис?"))) return;
    await api(`/vault/tables/${table.id}/entries/${id}`, { method: "DELETE" });
    if (tableKey) await loadAndDecryptEntries(tableKey);
  }

  async function copyEntryTo(entry: DecryptedEntry, destTableId: string) {
    const dest = allTables.find((tb) => tb.id === destTableId);
    if (!dest?.myWrap) return;
    try {
      const destKey = await unwrapTableKey(dest.myWrap.wrappedKey, privateKey);
      const { ciphertext, iv } = await encryptJson(destKey, entry.data);
      await api(`/vault/tables/${destTableId}/entries`, { method: "POST", body: JSON.stringify({ ciphertext, iv }) });
      setCopyingId(null);
      window.alert(t('Записът е копиран в "{name}".', { name: dest.name }));
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t("Грешка"));
    }
  }

  async function grantAccess(targetUserId: string, targetPublicKeyB64: string) {
    if (!tableKey) return;
    const targetPublicKey = await importPublicKeyB64(targetPublicKeyB64);
    const wrappedKey = await wrapTableKey(tableKey, targetPublicKey);
    await api(`/vault/tables/${table.id}/members`, {
      method: "POST",
      body: JSON.stringify({ userId: targetUserId, wrappedKey }),
    });
    await refreshMembers();
    await onTablesChanged();
  }

  async function revokeAccess(targetUserId: string) {
    if (!window.confirm(t("Наистина ли да отнемеш достъпа на този човек до тази таблица?"))) return;
    try {
      await api(`/vault/tables/${table.id}/members/${targetUserId}`, { method: "DELETE" });
      await refreshMembers();
      await onTablesChanged();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : t("Грешка"));
    }
  }

  function toggleReveal(id: string) {
    setRevealedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const visibleEntries = (entries ?? []).filter((e) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return e.data.title.toLowerCase().includes(q) || e.data.username.toLowerCase().includes(q) || e.data.url.toLowerCase().includes(q);
  });
  const sortedEntries = [...visibleEntries].sort((a, b) => a.data.title.localeCompare(b.data.title));

  const memberIds = new Set((members ?? []).map((m) => m.userId));
  const ungranted = candidates.filter((u) => !memberIds.has(u.id));
  const copyTargets = allTables.filter((tb) => tb.id !== table.id && tb.isMember);

  return (
    <div>
      <button className="secondary" onClick={onBack} style={{ marginBottom: 12 }}>
        {t("← Назад към таблиците")}
      </button>
      <div className="page-header">
        <h2 style={{ margin: 0 }}>{table.name}</h2>
      </div>
      {table.description && <p className="muted small">{table.description}</p>}

      <div className="tabs">
        {table.isMember && (
          <button className={tab === "entries" ? "active" : ""} onClick={() => setTab("entries")}>
            {t("Записи")}
          </button>
        )}
        {table.isMember && (
          <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>
            {t("История")}
          </button>
        )}
        {isSuperAdmin && (
          <button className={tab === "access" ? "active" : ""} onClick={() => setTab("access")}>
            {t("Управление на достъп")} ({table.memberCount})
          </button>
        )}
      </div>

      {tab === "access" && isSuperAdmin && (
        <VaultAccessPanel
          members={members ?? []}
          currentUserId={currentUserId}
          candidates={ungranted}
          canGrant={!!tableKey}
          onGrant={grantAccess}
          onRevoke={revokeAccess}
        />
      )}

      {tab === "history" && table.isMember && (
        <div className="vault-list">
          {(history ?? []).length === 0 ? (
            <p className="muted">{t("Все още няма история в тази таблица.")}</p>
          ) : (
            (history ?? []).map((row) => (
              <div className="vault-item" key={row.id}>
                <div className="vault-item-main">
                  <div className="vault-item-title">
                    {t(HISTORY_ACTION_LABELS[row.action])} · {row.title}
                  </div>
                  <div className="vault-item-sub muted small">
                    {row.actorName} · {new Date(row.createdAt).toLocaleString(locale)}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "entries" && table.isMember && entries && (
        <>
          <div className="vault-toolbar">
            <div className="search-input">
              <IconSearch size={16} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("Търсене по заглавие / потребител / URL")} />
            </div>
            <span className="spacer" />
            <button
              className="secondary"
              onClick={() => {
                setShowImport((s) => !s);
                setShowAddForm(false);
                setEditingId(null);
              }}
            >
              {showImport ? t("Затвори") : t("Импортирай")}
            </button>
            <button
              onClick={() => {
                setShowAddForm((s) => !s);
                setShowImport(false);
                setEditingId(null);
              }}
            >
              {showAddForm ? t("Затвори") : t("+ Нов запис")}
            </button>
          </div>

          {showImport && (
            <VaultImportPanel onImport={importEntries} onDone={() => setShowImport(false)} onCancel={() => setShowImport(false)} />
          )}

          {showAddForm && (
            <VaultEntryForm
              onSave={async (data) => {
                await saveEntry(data);
                setShowAddForm(false);
              }}
              onCancel={() => setShowAddForm(false)}
            />
          )}

          {sortedEntries.length === 0 ? (
            <p className="muted">{search.trim() ? t("Няма съвпадения.") : t("Vault-ът е празен.")}</p>
          ) : (
            <div className="vault-list">
              {sortedEntries.map((e) => {
                const isEditing = editingId === e.id;
                if (isEditing) {
                  return (
                    <VaultEntryForm
                      key={e.id}
                      item={e.data}
                      onSave={async (data) => {
                        await saveEntry(data, e.id);
                        setEditingId(null);
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  );
                }
                const revealed = revealedIds.has(e.id);
                return (
                  <div key={e.id}>
                    <div className="vault-item">
                      <Avatar id={e.id} name={e.data.title || "?"} size={36} />
                      <div className="vault-item-main">
                        <div className="vault-item-title">{e.data.title}</div>
                        <div className="vault-item-sub muted small">{e.data.username || t("без потребител")}</div>
                      </div>
                      <div className="vault-item-password">
                        <code>{revealed ? e.data.password || "—" : "••••••••"}</code>
                        {e.data.password && (
                          <>
                            <button
                              type="button"
                              className="icon-btn"
                              title={revealed ? t("Скрий") : t("Покажи")}
                              onClick={() => toggleReveal(e.id)}
                            >
                              {revealed ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              title={t("Копирай")}
                              onClick={() => navigator.clipboard.writeText(e.data.password)}
                            >
                              <IconCopy size={16} />
                            </button>
                          </>
                        )}
                      </div>
                      <div className="vault-item-url">
                        {e.data.url ? (
                          <a href={e.data.url} target="_blank" rel="noreferrer" title={e.data.url}>
                            {hostnameOf(e.data.url)}
                          </a>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </div>
                      <div className="vault-item-actions">
                        {e.data.url && (
                          <a className="icon-btn" href={e.data.url} target="_blank" rel="noreferrer" title={t("Отвори")}>
                            <IconExternalLink size={16} />
                          </a>
                        )}
                        {copyTargets.length > 0 && (
                          <button
                            type="button"
                            className="small-btn secondary"
                            title={t("Копирай в друга таблица")}
                            onClick={() => setCopyingId(copyingId === e.id ? null : e.id)}
                          >
                            {t("Копирай в…")}
                          </button>
                        )}
                        <button
                          type="button"
                          className="icon-btn"
                          title={t("Редактирай")}
                          onClick={() => {
                            setEditingId(e.id);
                            setShowAddForm(false);
                          }}
                        >
                          <IconEdit size={16} />
                        </button>
                        <button type="button" className="icon-btn danger" title={t("Изтрий")} onClick={() => deleteEntry(e.id)}>
                          <IconTrash size={16} />
                        </button>
                      </div>
                    </div>
                    {copyingId === e.id && (
                      <CopyToTableRow targets={copyTargets} onConfirm={(destId) => copyEntryTo(e, destId)} onCancel={() => setCopyingId(null)} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CopyToTableRow({
  targets,
  onConfirm,
  onCancel,
}: {
  targets: VaultTableSummary[];
  onConfirm: (destTableId: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [destId, setDestId] = useState(targets[0]?.id ?? "");
  const [submitting, setSubmitting] = useState(false);

  return (
    <div className="form-row" style={{ padding: "8px 16px", alignItems: "center" }}>
      <select value={destId} onChange={(e) => setDestId(e.target.value)}>
        {targets.map((tb) => (
          <option key={tb.id} value={tb.id}>
            {tb.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="small-btn"
        disabled={submitting || !destId}
        onClick={async () => {
          setSubmitting(true);
          await onConfirm(destId);
          setSubmitting(false);
        }}
      >
        {t("Копирай")}
      </button>
      <button type="button" className="small-btn secondary" onClick={onCancel}>
        {t("Отказ")}
      </button>
    </div>
  );
}

function VaultEntryForm({
  item,
  onSave,
  onCancel,
}: {
  item?: VaultEntryData;
  onSave: (data: VaultEntryData) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState(item?.title ?? "");
  const [username, setUsername] = useState(item?.username ?? "");
  const [password, setPassword] = useState(item?.password ?? "");
  const [url, setUrl] = useState(item?.url ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSave({ title, username, password, url, notes });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit}>
      <div className="form-row">
        <label>
          {t("Заглавие")}
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("Напр. Shopify admin")} required autoFocus />
        </label>
        <label>
          {t("Потребител")}
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
      </div>
      <div className="form-row">
        <label>
          {t("Парола")}
          <input type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button type="button" className="secondary" onClick={() => setShowPassword((s) => !s)}>
          {showPassword ? t("Скрий") : t("Покажи")}
        </button>
        <button type="button" className="secondary" onClick={() => setPassword(generateStrongPassword())}>
          {t("Генерирай")}
        </button>
      </div>
      <label>
        URL
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />
      </label>
      <label>
        {t("Бележка")}
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? t("Записване…") : t("Запази")}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t("Отказ")}
        </button>
      </div>
    </form>
  );
}

const VAULT_FIELD_LABEL_KEYS: Record<VaultField, string> = {
  title: "Заглавие",
  username: "Потребител",
  password: "Парола",
  url: "URL",
  notes: "Бележка",
};

// File parsing (parseImportFile) is entirely client-side — see
// lib/vaultImport.ts. Rows only ever leave this component as individually
// encrypted ciphertext, through the exact same onImport (→ importEntries →
// encryptJson → POST .../entries) path a manual single save uses.
function VaultImportPanel({
  onImport,
  onDone,
  onCancel,
}: {
  onImport: (dataList: VaultEntryData[], onProgress: (done: number, total: number) => void) => Promise<{ failed: number }>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [table, setTable] = useState<ParsedTable | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<VaultField, number>>>({});
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ imported: number; skipped: number; failed: number } | null>(null);

  async function handleFile(file: File) {
    setParseError(null);
    setTable(null);
    setResult(null);
    try {
      const parsed = await parseImportFile(file);
      if (parsed.rows.length === 0) {
        setParseError(t("Файлът не съдържа редове с данни."));
        return;
      }
      setTable(parsed);
      setMapping(guessColumnMapping(parsed.headers));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : t("Неуспешно разчитане на файла."));
    }
  }

  function cellAt(row: string[], field: VaultField): string {
    const idx = mapping[field];
    return idx != null ? (row[idx] ?? "").trim() : "";
  }

  function buildRows(): VaultEntryData[] {
    if (!table) return [];
    const out: VaultEntryData[] = [];
    for (const row of table.rows) {
      const password = cellAt(row, "password");
      if (!password) continue; // nothing to protect — skip rows with no password
      const url = cellAt(row, "url");
      const title = cellAt(row, "title") || (url ? hostnameOf(url) : t("Без заглавие"));
      out.push({ title, username: cellAt(row, "username"), password, url, notes: cellAt(row, "notes") });
    }
    return out;
  }

  const validRows = table ? buildRows() : [];
  const skippedCount = table ? table.rows.length - validRows.length : 0;

  async function handleImport() {
    setImporting(true);
    setProgress({ done: 0, total: validRows.length });
    const { failed } = await onImport(validRows, (done, total) => setProgress({ done, total }));
    setImporting(false);
    setResult({ imported: validRows.length - failed, skipped: skippedCount, failed });
  }

  return (
    <div className="card">
      <p>
        <strong>{t("Импортирай от CSV или XLSX")}</strong>
      </p>
      <p className="muted small">
        {t(
          "Поддържа износи от 1Password, Chrome/Edge, Firefox (CSV) или произволна .xlsx таблица. Файлът се чете изцяло в браузъра ти — никога не се качва никъде. Изтрий го от компютъра си след импортирането, ако съдържа истински пароли."
        )}
      </p>

      {!result && (
        <>
          <input
            type="file"
            accept=".csv,.txt,.xlsx,.xls"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
          {parseError && <div className="error-text">{parseError}</div>}

          {table && (
            <>
              <div className="form-row" style={{ marginTop: 14 }}>
                {VAULT_FIELDS.map((field) => (
                  <label key={field}>
                    {t(VAULT_FIELD_LABEL_KEYS[field])}
                    <select
                      value={mapping[field] ?? ""}
                      onChange={(e) =>
                        setMapping((m) => ({ ...m, [field]: e.target.value === "" ? undefined : Number(e.target.value) }))
                      }
                    >
                      <option value="">{t("— няма —")}</option>
                      {table.headers.map((h, i) => (
                        <option key={i} value={i}>
                          {h || `#${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>

              <p className="muted small">
                {t("{count} реда ще бъдат импортирани", { count: validRows.length })}
                {skippedCount > 0 && ` · ${t("{count} пропуснати (без парола)", { count: skippedCount })}`}
              </p>

              {validRows.length > 0 && (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t("Заглавие")}</th>
                        <th>{t("Потребител")}</th>
                        <th>{t("Парола")}</th>
                        <th>URL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validRows.slice(0, 5).map((r, i) => (
                        <tr key={i}>
                          <td data-label={t("Заглавие")}>{r.title}</td>
                          <td data-label={t("Потребител")}>{r.username || "—"}</td>
                          <td data-label={t("Парола")}>
                            <code>••••••••</code>
                          </td>
                          <td data-label="URL">{r.url || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {validRows.length > 5 && <p className="muted small">{t("… и още {count}", { count: validRows.length - 5 })}</p>}

              {importing && progress && (
                <p className="muted small">{t("Импортиране… {done}/{total}", { done: progress.done, total: progress.total })}</p>
              )}

              <div className="form-row">
                <button onClick={handleImport} disabled={importing || validRows.length === 0}>
                  {importing ? t("Импортиране…") : t("Импортирай {count} записа", { count: validRows.length })}
                </button>
                <button type="button" className="secondary" onClick={onCancel} disabled={importing}>
                  {t("Отказ")}
                </button>
              </div>
            </>
          )}
        </>
      )}

      {result && (
        <div>
          <p>
            {t("Импортирани: {imported}", { imported: result.imported })}
            {result.skipped > 0 && ` · ${t("пропуснати: {skipped}", { skipped: result.skipped })}`}
            {result.failed > 0 && ` · ${t("грешки: {failed}", { failed: result.failed })}`}
          </p>
          <button onClick={onDone}>{t("Готово")}</button>
        </div>
      )}
    </div>
  );
}

function VaultAccessPanel({
  members,
  currentUserId,
  candidates,
  canGrant,
  onGrant,
  onRevoke,
}: {
  members: VaultTableMemberInfo[];
  currentUserId: string;
  candidates: User[];
  canGrant: boolean;
  onGrant: (userId: string, targetPublicKeyB64: string) => Promise<void>;
  onRevoke: (userId: string) => Promise<void>;
}) {
  const { t, lang } = useI18n();
  const locale = lang === "en" ? "en-GB" : "bg-BG";
  const [showGrantForm, setShowGrantForm] = useState(false);

  return (
    <div>
      {!canGrant && (
        <p className="muted small">
          {t("Нямаш тази таблица отключена, затова не можеш да добавяш нови хора — можеш само да виждаш и да отнемаш достъп.")}
        </p>
      )}
      <div className="vault-list">
        {members.map((g) => (
          <div className="vault-item" key={g.userId}>
            <Avatar id={g.userId} name={g.name} size={36} />
            <div className="vault-item-main">
              <div className="vault-item-title">
                {g.name}
                {g.userId === currentUserId && <span className="muted small"> ({t("ти")})</span>}
                {g.isSuperAdmin && (
                  <span className="badge badge-info" style={{ marginLeft: 8 }}>
                    Admin
                  </span>
                )}
              </div>
              <div className="vault-item-sub muted small">
                {t("Предоставено от")} {g.grantedByName ?? "—"} · {new Date(g.createdAt).toLocaleDateString(locale)}
              </div>
            </div>
            <div className="vault-item-actions">
              <button className="small-btn" onClick={() => onRevoke(g.userId)}>
                {t("Отнеми достъп")}
              </button>
            </div>
          </div>
        ))}
      </div>

      {canGrant && candidates.length > 0 && !showGrantForm && (
        <button onClick={() => setShowGrantForm(true)} style={{ marginTop: 12 }}>
          {t("+ Добави достъп")}
        </button>
      )}

      {showGrantForm && (
        <GrantAccessForm
          candidates={candidates}
          onGrant={async (userId, publicKey) => {
            await onGrant(userId, publicKey);
            setShowGrantForm(false);
          }}
          onCancel={() => setShowGrantForm(false)}
        />
      )}
    </div>
  );
}

// No password field anywhere here, on purpose: granting access only ever
// needs the recipient's PUBLIC key (fetched below), which isn't secret —
// their master password never touches this screen, this browser, or this
// admin, at any point.
function GrantAccessForm({
  candidates,
  onGrant,
  onCancel,
}: {
  candidates: User[];
  onGrant: (userId: string, targetPublicKeyB64: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [userId, setUserId] = useState(candidates[0]?.id ?? "");
  const [targetKey, setTargetKey] = useState<VaultUserPublicKey | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!userId) return;
    setTargetKey(undefined);
    api<VaultUserPublicKey | null>(`/vault/users/${userId}/key`).then(setTargetKey);
  }, [userId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!userId) {
      setError(t("Избери служител."));
      return;
    }
    if (!targetKey) return;
    setSubmitting(true);
    try {
      await onGrant(userId, targetKey.publicKey);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit} style={{ marginTop: 12 }}>
      <label>
        {t("Служител")}
        <select value={userId} onChange={(e) => setUserId(e.target.value)} required>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      {targetKey === null && (
        <p className="muted small">
          {t(
            "Този човек още няма личен vault ключ — трябва сам, по всяко време, да отвори Vault и да си зададе master парола. Чак тогава ще можеш да му дадеш достъп (без да е нужно нищо друго от него)."
          )}
        </p>
      )}
      {targetKey && <p className="muted small">{t("Готово за достъп — не е нужна парола от него, само едно кликване.")}</p>}

      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting || !targetKey}>
          {submitting ? t("Записване…") : t("Предостави достъп")}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t("Отказ")}
        </button>
      </div>
    </form>
  );
}
