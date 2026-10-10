import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError } from "../api/client";
import type { User, VaultEntry, VaultEntryData, VaultStatus } from "../api/types";
import { Avatar } from "../components/Avatar";
import { IconCopy, IconEdit, IconExternalLink, IconEye, IconEyeOff, IconLock, IconSearch, IconTrash } from "../components/icons";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n/I18nContext";
import {
  PBKDF2_ITERATIONS,
  decryptJson,
  deriveStretchedKey,
  encryptJson,
  generateSaltB64,
  generateVaultKey,
  unwrapVaultKey,
  wrapVaultKey,
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

// `vaultKey` lives only in this component's state — it is NEVER written to
// localStorage/sessionStorage/cookies, so navigating away from this page
// (unmounting it) or reloading the browser re-locks the vault automatically.
// See web/src/lib/vaultCrypto.ts for what every crypto call below actually
// does; nothing here ever sends a password or a derived key to the server.
export function Vault() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [vaultKey, setVaultKey] = useState<CryptoKey | null>(null);
  const [entries, setEntries] = useState<DecryptedEntry[] | null>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAccessPanel, setShowAccessPanel] = useState(false);
  const [search, setSearch] = useState("");
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [superAdmins, setSuperAdmins] = useState<User[]>([]);

  async function refreshStatus() {
    setStatus(await api<VaultStatus>("/vault/status"));
  }

  useEffect(() => {
    Promise.all([refreshStatus(), api<User[]>("/users").then((all) => setSuperAdmins(all.filter((u) => u.isSuperAdmin && u.active)))]).finally(
      () => setLoading(false)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAndDecryptEntries(key: CryptoKey) {
    const raw = await api<VaultEntry[]>("/vault/entries");
    const decrypted: DecryptedEntry[] = [];
    for (const e of raw) {
      try {
        const data = await decryptJson<VaultEntryData>(key, e.ciphertext, e.iv);
        decrypted.push({ id: e.id, data, createdBy: e.createdBy, createdAt: e.createdAt });
      } catch {
        // Would only happen for a row encrypted under a different VK than
        // the one we just unwrapped — skip it rather than crash the page.
      }
    }
    setEntries(decrypted);
  }

  async function handleUnlock(password: string) {
    if (!status?.myWrap) return;
    setUnlockError(null);
    setUnlocking(true);
    try {
      const stretched = await deriveStretchedKey(password, status.myWrap.salt, status.myWrap.iterations);
      const vk = await unwrapVaultKey(status.myWrap.wrappedKey, status.myWrap.wrappedKeyIv, stretched);
      setVaultKey(vk);
      await loadAndDecryptEntries(vk);
    } catch {
      setUnlockError(t("Грешна master парола."));
    } finally {
      setUnlocking(false);
    }
  }

  function lock() {
    setVaultKey(null);
    setEntries(null);
    setRevealedIds(new Set());
    setShowAddForm(false);
    setEditingId(null);
    setShowAccessPanel(false);
  }

  async function handleInit(password: string) {
    const salt = generateSaltB64();
    const stretched = await deriveStretchedKey(password, salt, PBKDF2_ITERATIONS);
    const vk = await generateVaultKey();
    const { wrappedKey, wrappedKeyIv } = await wrapVaultKey(vk, stretched);
    await api("/vault/init", {
      method: "POST",
      body: JSON.stringify({ salt, wrappedKey, wrappedKeyIv, iterations: PBKDF2_ITERATIONS }),
    });
    await refreshStatus();
    setVaultKey(vk);
    await loadAndDecryptEntries(vk);
  }

  async function saveEntry(data: VaultEntryData, existingId?: string) {
    if (!vaultKey) return;
    const { ciphertext, iv } = await encryptJson(vaultKey, data);
    if (existingId) {
      await api(`/vault/entries/${existingId}`, { method: "PATCH", body: JSON.stringify({ ciphertext, iv }) });
    } else {
      await api("/vault/entries", { method: "POST", body: JSON.stringify({ ciphertext, iv }) });
    }
    await loadAndDecryptEntries(vaultKey);
  }

  // Imports already go one row at a time through the exact same
  // encrypt-then-POST path as a manual save — nothing about bulk import
  // gets a shortcut around the per-entry encryption.
  async function importEntries(dataList: VaultEntryData[], onProgress: (done: number, total: number) => void): Promise<{ failed: number }> {
    if (!vaultKey) return { failed: dataList.length };
    let failed = 0;
    for (let i = 0; i < dataList.length; i++) {
      try {
        const { ciphertext, iv } = await encryptJson(vaultKey, dataList[i]);
        await api("/vault/entries", { method: "POST", body: JSON.stringify({ ciphertext, iv }) });
      } catch {
        failed++;
      }
      onProgress(i + 1, dataList.length);
    }
    await loadAndDecryptEntries(vaultKey);
    return { failed };
  }

  async function deleteEntry(id: string) {
    if (!window.confirm(t("Наистина ли да изтрия този запис?"))) return;
    await api(`/vault/entries/${id}`, { method: "DELETE" });
    if (vaultKey) await loadAndDecryptEntries(vaultKey);
  }

  async function grantAccess(targetUserId: string, theirPassword: string) {
    if (!vaultKey) return;
    const salt = generateSaltB64();
    const stretched = await deriveStretchedKey(theirPassword, salt, PBKDF2_ITERATIONS);
    const { wrappedKey, wrappedKeyIv } = await wrapVaultKey(vaultKey, stretched);
    await api("/vault/grant", {
      method: "POST",
      body: JSON.stringify({ userId: targetUserId, salt, wrappedKey, wrappedKeyIv, iterations: PBKDF2_ITERATIONS }),
    });
    await refreshStatus();
  }

  async function revokeAccess(targetUserId: string) {
    if (!window.confirm(t("Наистина ли да отнемеш достъпа на този admin до vault-а?"))) return;
    try {
      await api(`/vault/grant/${targetUserId}`, { method: "DELETE" });
      await refreshStatus();
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

  if (loading) return <p>{t("Зареждане…")}</p>;
  if (!status) return null;

  const visibleEntries = (entries ?? []).filter((e) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return e.data.title.toLowerCase().includes(q) || e.data.username.toLowerCase().includes(q) || e.data.url.toLowerCase().includes(q);
  });
  // Alphabetical by title — a stable, predictable order (not insertion
  // order), the way a password manager's item list usually reads.
  const sortedEntries = [...visibleEntries].sort((a, b) => a.data.title.localeCompare(b.data.title));

  const grantedUserIds = new Set(status.grantedTo.map((g) => g.userId));
  const ungranted = superAdmins.filter((u) => !grantedUserIds.has(u.id));

  return (
    <div>
      <div className="page-header">
        <h1>{t("Vault")}</h1>
        {vaultKey && (
          <button className="secondary" onClick={lock}>
            {t("Заключи")}
          </button>
        )}
      </div>
      <p className="muted">
        {t(
          "Криптирана база за пароли, логини и чувствителна информация — zero-knowledge: криптирането/декриптирането става в браузъра ти, сървърът никога не вижда plaintext данните нито master паролата ти. Отделна е от паролата ти за влизане в TODF."
        )}
      </p>

      {!status.initialized && <VaultSetupForm onSubmit={handleInit} />}

      {status.initialized && !status.myWrap && (
        <div className="vault-gate">
          <div className="vault-gate-icon">
            <IconLock size={26} />
          </div>
          <p>
            <strong>{t("Нямаш достъп до vault-а все още.")}</strong>
          </p>
          <p className="muted small">
            {t("Помоли някой от следните да ти предостави достъп (трябва да е при теб, докато vault-ът е отключен в неговия браузър):")}
          </p>
          <div className="vault-list" style={{ textAlign: "left" }}>
            {status.grantedTo.map((g) => (
              <div className="vault-item" key={g.userId}>
                <Avatar id={g.userId} name={g.name} size={32} />
                <div className="vault-item-main">
                  <div className="vault-item-title">{g.name}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {status.initialized && status.myWrap && !vaultKey && (
        <VaultUnlockForm onSubmit={handleUnlock} error={unlockError} submitting={unlocking} />
      )}

      {vaultKey && entries && (
        <>
          <div className="tabs">
            <button className={!showAccessPanel ? "active" : ""} onClick={() => setShowAccessPanel(false)}>
              {t("Записи")}
            </button>
            <button className={showAccessPanel ? "active" : ""} onClick={() => setShowAccessPanel(true)}>
              {t("Управление на достъп")} ({status.grantedTo.length})
            </button>
          </div>

          {showAccessPanel ? (
            <VaultAccessPanel
              grantedTo={status.grantedTo}
              currentUserId={user!.id}
              candidates={ungranted}
              onGrant={grantAccess}
              onRevoke={revokeAccess}
            />
          ) : (
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
                <VaultImportPanel
                  onImport={importEntries}
                  onDone={() => setShowImport(false)}
                  onCancel={() => setShowImport(false)}
                />
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
                      <div className="vault-item" key={e.id}>
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
                            <a
                              className="icon-btn"
                              href={e.data.url}
                              target="_blank"
                              rel="noreferrer"
                              title={t("Отвори")}
                            >
                              <IconExternalLink size={16} />
                            </a>
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
                    );
                  })}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function VaultSetupForm({ onSubmit }: { onSubmit: (password: string) => Promise<void> }) {
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
        <strong>{t("Vault-ът още не е инициализиран.")}</strong>
      </p>
      <p className="muted small">
        {t(
          "Задай master парола — тя никога не се изпраща към сървъра и не може да бъде възстановена от никого, ако я забравиш. Избери нещо отделно от паролата ти за влизане в TODF."
        )}
      </p>
      <div className="form-row">
        <label>
          {t("Master парола")}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
        </label>
        <label>
          {t("Потвърди паролата")}
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
      </div>
      {error && <div className="error-text">{error}</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? t("Инициализиране…") : t("Инициализирай vault-а")}
      </button>
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
      <label>
        {t("Master парола")}
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
      </label>
      {error && <div className="error-text">{error}</div>}
      <button type="submit" disabled={submitting}>
        {submitting ? t("Отключване…") : t("Отключи")}
      </button>
    </form>
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
// encryptJson → POST /vault/entries) path a manual single save uses.
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
              {validRows.length > 5 && (
                <p className="muted small">{t("… и още {count}", { count: validRows.length - 5 })}</p>
              )}

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
  grantedTo,
  currentUserId,
  candidates,
  onGrant,
  onRevoke,
}: {
  grantedTo: VaultStatus["grantedTo"];
  currentUserId: string;
  candidates: User[];
  onGrant: (userId: string, theirPassword: string) => Promise<void>;
  onRevoke: (userId: string) => Promise<void>;
}) {
  const { t, lang } = useI18n();
  const locale = lang === "en" ? "en-GB" : "bg-BG";
  const [showGrantForm, setShowGrantForm] = useState(false);

  return (
    <div>
      <div className="vault-list">
        {grantedTo.map((g) => (
          <div className="vault-item" key={g.userId}>
            <Avatar id={g.userId} name={g.name} size={36} />
            <div className="vault-item-main">
              <div className="vault-item-title">
                {g.name}
                {g.userId === currentUserId && <span className="muted small"> ({t("ти")})</span>}
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

      {candidates.length > 0 && !showGrantForm && (
        <button onClick={() => setShowGrantForm(true)} style={{ marginTop: 12 }}>
          {t("+ Добави достъп за друг admin")}
        </button>
      )}

      {showGrantForm && (
        <GrantAccessForm
          candidates={candidates}
          onGrant={async (userId, pw) => {
            await onGrant(userId, pw);
            setShowGrantForm(false);
          }}
          onCancel={() => setShowGrantForm(false)}
        />
      )}
    </div>
  );
}

function GrantAccessForm({
  candidates,
  onGrant,
  onCancel,
}: {
  candidates: User[];
  onGrant: (userId: string, theirPassword: string) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [userId, setUserId] = useState(candidates[0]?.id ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!userId) {
      setError(t("Избери admin."));
      return;
    }
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
      await onGrant(userId, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("Грешка"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card form" onSubmit={handleSubmit} style={{ marginTop: 12 }}>
      <p className="muted small">
        {t(
          "Новият admin трябва да е лично тук и сам да въведе master паролата си — тя никога не трябва да се споделя по чат/имейл, защото криптира целия vault."
        )}
      </p>
      <div className="form-row">
        <label>
          Admin
          <select value={userId} onChange={(e) => setUserId(e.target.value)} required>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Негова/нейна master парола")}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label>
          {t("Потвърди паролата")}
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="form-row">
        <button type="submit" disabled={submitting}>
          {submitting ? t("Записване…") : t("Предостави достъп")}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          {t("Отказ")}
        </button>
      </div>
    </form>
  );
}
